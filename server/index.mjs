import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

const execFileAsync = promisify(execFile);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const PORT = Number(process.env.PORT || 4317);
const POLL_CACHE_MS = 1500;
const PUBLIC_INFO_CACHE_MS = 10 * 60 * 1000;
const PUBLIC_INFO_ERROR_CACHE_MS = 60 * 1000;
const SPEEDTEST_INTERVAL_MS = 60 * 1000;
const SPEEDTEST_HISTORY_LIMIT = 120;

let diagnosticsCache = null;
let diagnosticsCacheAt = 0;
let speedtestRunning = false;
let speedtestTimer = null;
let speedtestNextRunAt = null;
let speedtestHistory = [];
let speedtestRateLimitedUntil = null;
let speedtestRateLimitReason = null;
let publicNetworkInfo = null;
let publicNetworkInfoAt = 0;
let publicNetworkLookupRunning = null;
let publicNetworkLookupStartedAt = 0;
let lastSpeedtest = {
  status: "idle",
  downloadMbps: null,
  uploadMbps: null,
  latencyMs: null,
  publicIp: null,
  isp: null,
  asn: null,
  location: null,
  bytes: 0,
  uploadBytes: 0,
  durationMs: 0,
  uploadDurationMs: 0,
  testedAt: null,
  publicInfoUpdatedAt: null,
  publicInfoError: null,
  publicInfoStatus: "idle",
  rateLimitedUntil: null,
  rateLimitSeconds: 0,
  rateLimitReason: null,
  error: null,
};
let lldpInstallRunning = false;
let lldpCaptureRunning = false;
let lastLldpCapture = null;
let ipScanRunning = false;
let ipScanQueued = false;
let ipScanState = {
  status: "idle",
  startedAt: null,
  completedAt: null,
  subnet: null,
  range: null,
  scannedHosts: 0,
  totalHosts: 0,
  devices: [],
  error: null,
  message: "Run a scan to discover devices on the local network.",
};

const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const IP_SCAN_PORTS = [21, 22, 23, 25, 53, 80, 135, 139, 443, 445, 554, 3389, 5357, 8000, 8080, 8443, 9100];
const PORT_LABELS = {
  21: "FTP",
  22: "SSH",
  23: "Telnet",
  25: "SMTP",
  53: "DNS",
  80: "HTTP",
  135: "RPC",
  139: "NetBIOS",
  443: "HTTPS",
  445: "SMB",
  554: "RTSP",
  3389: "RDP",
  5357: "WSDAPI",
  8000: "HTTP alt",
  8080: "HTTP alt",
  8443: "HTTPS alt",
  9100: "Printer",
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".ico": "image/x-icon",
    }[ext] || "application/octet-stream"
  );
}

async function sendStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const resolved = path.resolve(DIST_DIR, `.${requested}`);
  const safePath = resolved.startsWith(DIST_DIR) ? resolved : path.join(DIST_DIR, "index.html");

  try {
    const file = await fs.readFile(safePath);
    res.writeHead(200, {
      "Content-Type": contentType(safePath),
      "Cache-Control": safePath.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
    });
    res.end(file);
  } catch {
    const index = await fs.readFile(path.join(DIST_DIR, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(index);
  }
}

async function runPowerShell(script, timeout = 8000) {
  if (process.platform !== "win32") {
    throw new Error("PowerShell network inventory is currently implemented for Windows hosts.");
  }

  const { stdout } = await execFileAsync(
    powershell,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeout, maxBuffer: 1024 * 1024 * 4 },
  );
  return stdout.trim();
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function isProcessElevated() {
  if (process.platform !== "win32") return process.getuid?.() === 0;

  try {
    const output = await runPowerShell(
      "([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
      5000,
    );
    return output.trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

async function restartElevated() {
  if (process.platform !== "win32") {
    return { status: "unsupported", message: "Elevated restart is currently implemented for Windows only." };
  }

  const nodePath = process.execPath;
  const serverPath = fileURLToPath(import.meta.url);
  const elevatedCommand = `
$node = ${psQuote(nodePath)}
$server = ${psQuote(serverPath)}
$working = ${psQuote(ROOT_DIR)}
$port = ${PORT}
$deadline = (Get-Date).AddSeconds(25)
while ((Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {
  Start-Sleep -Milliseconds 300
}
Set-Location -LiteralPath $working
& $node $server
`;
  const encodedCommand = Buffer.from(elevatedCommand, "utf16le").toString("base64");
  const script = `
Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ${psQuote(encodedCommand)} -WorkingDirectory ${psQuote(ROOT_DIR)} -Verb RunAs
`;

  await runPowerShell(script, 10000);

  setTimeout(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2500).unref();
  }, 500).unref();

  return {
    status: "restarting",
    message: "Approve the Windows UAC prompt. This backend will stop so the elevated backend can reuse the same port.",
  };
}

async function psDiscoveryProtocolStatus() {
  if (process.platform !== "win32") {
    return { installed: false, provider: "PSDiscoveryProtocol", supported: false, elevated: await isProcessElevated() };
  }

  try {
    const [output, elevated] = await Promise.all([
      runPowerShell(
        "Get-Module -ListAvailable PSDiscoveryProtocol | Select-Object -First 1 Name,Version | ConvertTo-Json -Compress",
        5000,
      ),
      isProcessElevated(),
    ]);
    return output
      ? { installed: true, provider: "PSDiscoveryProtocol", supported: true, elevated, module: JSON.parse(output) }
      : { installed: false, provider: "PSDiscoveryProtocol", supported: true, elevated };
  } catch (error) {
    return { installed: false, provider: "PSDiscoveryProtocol", supported: true, elevated: await isProcessElevated(), error: error.message };
  }
}

async function installLldpAgent() {
  if (lldpInstallRunning) return { status: "running", message: "LLDP module install is already running." };
  lldpInstallRunning = true;

  try {
    const script = `
$ProgressPreference = 'SilentlyContinue'
Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue
Install-Module -Name PSDiscoveryProtocol -Scope CurrentUser -Force -AllowClobber
Get-Module -ListAvailable PSDiscoveryProtocol | Select-Object -First 1 Name,Version | ConvertTo-Json -Compress
`;
    const output = await runPowerShell(script, 120000);
    diagnosticsCache = null;
    return { status: "complete", module: output ? JSON.parse(output) : null };
  } catch (error) {
    return { status: "error", error: error.message };
  } finally {
    lldpInstallRunning = false;
  }
}

async function getAdapterSnapshot() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$adapters = Get-NetAdapter -Physical | Where-Object {
  $_.Name -match 'Ethernet|USB|GbE|2.5|5G|10G|LAN' -or $_.NdisPhysicalMedium -eq 14 -or $_.InterfaceDescription -match 'Ethernet|Realtek|Intel|USB'
}
if (-not $adapters) { $adapters = Get-NetAdapter -Physical }
$rows = foreach ($adapter in $adapters) {
  $ip = Get-NetIPConfiguration -InterfaceIndex $adapter.ifIndex
  $ipv4 = $ip.IPv4Address | Select-Object -First 1
  $gateway = $ip.IPv4DefaultGateway | Select-Object -First 1
  $dns = @($ip.DNSServer.ServerAddresses | Where-Object { $_ -match '^\\d+\\.' })
  [pscustomobject]@{
    Name = $adapter.Name
    Description = $adapter.InterfaceDescription
    MacAddress = $adapter.MacAddress
    Status = $adapter.Status
    LinkSpeed = $adapter.LinkSpeed
    InterfaceIndex = $adapter.ifIndex
    IPv4Address = $ipv4.IPAddress
    PrefixLength = $ipv4.PrefixLength
    Gateway = $gateway.NextHop
    DnsServers = $dns
    DhcpEnabled = (Get-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4).Dhcp
  }
}
$rows | ConvertTo-Json -Depth 6
`;
  try {
    const output = await runPowerShell(script);
    if (!output) return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function getIpConfigText() {
  if (process.platform !== "win32") return "";
  const { stdout } = await execFileAsync("ipconfig.exe", ["/all"], {
    timeout: 8000,
    maxBuffer: 1024 * 1024 * 4,
  });
  return stdout;
}

function parseIpConfigByAdapter(text) {
  const sections = text.split(/\r?\n(?=[A-Za-z].* adapter .*:)/);
  const result = new Map();

  for (const section of sections) {
    const title = section.match(/^(.+?) adapter (.+?):/m);
    if (!title) continue;
    const name = title[2].trim();
    const field = (label) => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = section.match(new RegExp(`${escaped}[^:]*:\\s*([^\\r\\n]*)(?:\\r?\\n\\s+([^:\\r\\n][^\\r\\n]*))?`, "i"));
      return match ? (match[1].trim() || match[2]?.trim() || null) : null;
    };

    const gateway = field("Default Gateway");

    result.set(name.toLowerCase(), {
      name,
      mediaDisconnected: /Media State[^:]*:\s*Media disconnected/i.test(section),
      dhcpServer: field("DHCP Server"),
      leaseObtained: field("Lease Obtained"),
      leaseExpires: field("Lease Expires"),
      connectionSpecificDnsSuffix: field("Connection-specific DNS Suffix"),
      physicalAddress: field("Physical Address"),
      description: field("Description"),
      ipv4Address: field("IPv4 Address")?.replace(/\(Preferred\)/i, "").trim() || null,
      subnetMask: field("Subnet Mask"),
      gateway: gateway && /^\d+\./.test(gateway) ? gateway : null,
      dhcpEnabled: field("DHCP Enabled"),
      dnsServers: section
        .match(/DNS Servers[^:]*:\s*([^\r\n]+)(?:\r?\n\s+([^\r\n]+))?/i)
        ?.slice(1)
        .filter(Boolean)
        .map((value) => value.trim())
        .filter((value) => /^\d+\./.test(value)) || [],
    });
  }

  return result;
}

function ipConfigEntries(text) {
  return Array.from(parseIpConfigByAdapter(text).values());
}

function adaptersFromIpConfig(text) {
  return ipConfigEntries(text)
    .filter((entry) => /ethernet|usb|gbe|lan|realtek|intel|2\.5|5g|10g/i.test(`${entry.name} ${entry.description || ""}`))
    .map((entry, index) => ({
      Name: entry.name,
      Description: entry.description,
      MacAddress: entry.physicalAddress,
      Status: entry.mediaDisconnected ? "Disconnected" : entry.ipv4Address ? "Up" : "Unknown",
      LinkSpeed: null,
      InterfaceIndex: index,
      IPv4Address: entry.ipv4Address,
      PrefixLength: null,
      SubnetMask: entry.subnetMask,
      Gateway: entry.gateway,
      DnsServers: entry.dnsServers,
      DhcpEnabled: entry.dhcpEnabled,
    }));
}

async function resolveMacAddress(ipAddress) {
  if (!ipAddress || process.platform !== "win32") return null;
  try {
    const output = await runPowerShell(
      `(Get-NetNeighbor -AddressFamily IPv4 -IPAddress '${ipAddress}' -ErrorAction SilentlyContinue | Select-Object -First 1).LinkLayerAddress`,
      3000,
    );
    if (output) return output;
  } catch {
    // Fall through to ARP below.
  }

  try {
    const { stdout } = await execFileAsync("arp.exe", ["-a", ipAddress], { timeout: 3000 });
    const match = stdout.match(new RegExp(`${ipAddress.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+([0-9a-f-]{17})`, "i"));
    return match?.[1]?.toUpperCase() || null;
  } catch {
    return null;
  }
}

function prefixToSubnetMask(prefixLength) {
  if (prefixLength === null || prefixLength === undefined || Number.isNaN(Number(prefixLength))) return null;
  const bits = Number(prefixLength);
  const mask = [0, 0, 0, 0].map((_, index) => {
    const remaining = Math.max(0, Math.min(8, bits - index * 8));
    return remaining === 0 ? 0 : 256 - 2 ** (8 - remaining);
  });
  return mask.join(".");
}

function subnetMaskToPrefix(subnetMask) {
  const mask = ipToInt(subnetMask);
  if (mask === null) return null;
  const bits = mask.toString(2).padStart(32, "0");
  if (!/^1*0*$/.test(bits)) return null;
  return bits.indexOf("0") === -1 ? 32 : bits.indexOf("0");
}

function ipToInt(ipAddress) {
  const parts = String(ipAddress || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}

function intToIp(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

function subnetHosts(ipAddress, prefixLength) {
  const ip = ipToInt(ipAddress);
  const prefix = Number(prefixLength);
  if (ip === null || !Number.isInteger(prefix) || prefix < 1 || prefix > 30) return null;

  const scanPrefix = Math.max(prefix, 24);
  const mask = (0xffffffff << (32 - scanPrefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const hosts = [];

  for (let value = network + 1; value < broadcast; value += 1) {
    hosts.push(intToIp(value));
  }

  return {
    hosts,
    subnet: `${intToIp(network)}/${scanPrefix}`,
    range: `${intToIp(network + 1)} - ${intToIp(broadcast - 1)}`,
    capped: scanPrefix !== prefix,
  };
}

function getActiveIpv4Network() {
  const interfaces = os.networkInterfaces();
  const candidates = Object.entries(interfaces).flatMap(([name, entries]) =>
    (entries || [])
      .filter((entry) => entry.family === "IPv4" && !entry.internal && entry.address && entry.netmask)
      .map((entry) => ({ name, ...entry })),
  );
  const preferred =
    candidates.find((entry) => /ethernet|usb|gbe|lan|realtek|intel|2\.5|5g|10g/i.test(`${entry.name} ${entry.mac || ""}`)) ||
    candidates[0] ||
    null;

  if (!preferred) {
    const cached = diagnosticsCache?.network;
    return cached
      ? {
          ipAddress: cached.ipAddress,
          prefixLength: cached.prefixLength ?? subnetMaskToPrefix(cached.subnetMask),
          subnetMask: cached.subnetMask,
          gateway: cached.gateway,
          macAddress: diagnosticsCache?.adapter?.macAddress || null,
        }
      : null;
  }

  return {
    ipAddress: preferred.address,
    prefixLength: subnetMaskToPrefix(preferred.netmask),
    subnetMask: preferred.netmask,
    gateway: diagnosticsCache?.network?.gateway || null,
    macAddress: preferred.mac && preferred.mac !== "00:00:00:00:00:00" ? preferred.mac.toUpperCase().replace(/:/g, "-") : null,
  };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function pingHost(ipAddress) {
  if (process.platform === "win32") {
    try {
      await execFileAsync("ping.exe", ["-n", "1", "-w", "350", ipAddress], { timeout: 1200, maxBuffer: 1024 * 64 });
      return true;
    } catch {
      return false;
    }
  }

  try {
    await execFileAsync("ping", ["-c", "1", "-W", "1", ipAddress], { timeout: 1500, maxBuffer: 1024 * 64 });
    return true;
  } catch {
    return false;
  }
}

async function readArpTable() {
  if (process.platform !== "win32") return new Map();

  try {
    const { stdout } = await execFileAsync("arp.exe", ["-a"], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const entries = new Map();
    for (const match of stdout.matchAll(/(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f-]{17})\s+(\w+)/gi)) {
      entries.set(match[1], { macAddress: match[2].toUpperCase(), type: match[3] });
    }
    return entries;
  } catch {
    return new Map();
  }
}

async function resolveHostname(ipAddress) {
  try {
    const names = await dns.reverse(ipAddress);
    if (names.length) return names[0].replace(/\.$/, "");
  } catch {
    // Fall through to NetBIOS below.
  }

  if (process.platform !== "win32") return null;

  try {
    const { stdout } = await execFileAsync("nbtstat.exe", ["-A", ipAddress], { timeout: 1800, maxBuffer: 1024 * 64 });
    const match = stdout.match(/^\s*([^\s<][^<]{0,14}?)\s+<00>\s+UNIQUE/im);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function checkTcpPort(ipAddress, port, timeoutMs = 260) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, ipAddress);
  });
}

async function scanOpenPorts(ipAddress) {
  const checks = await mapLimit(IP_SCAN_PORTS, 4, async (port) => {
    const open = await checkTcpPort(ipAddress, port);
    return open ? { port, service: PORT_LABELS[port] || "TCP" } : null;
  });
  return checks.filter(Boolean);
}

function runIpScanWorker({ hosts, network }) {
  const workerScript = `
const { parentPort, workerData } = require("node:worker_threads");
const net = require("node:net");
const dns = require("node:dns").promises;
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

function ipToInt(ipAddress) {
  return String(ipAddress).split(".").map(Number).reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function checkTcpPort(ipAddress, port, timeoutMs = 260) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, ipAddress);
  });
}

async function scanOpenPorts(ipAddress) {
  const checks = await mapLimit(workerData.ports, 6, async (port) => {
    const open = await checkTcpPort(ipAddress, port);
    return open ? { port, service: workerData.labels[String(port)] || "TCP" } : null;
  });
  return checks.filter(Boolean);
}

async function readArpTable() {
  if (workerData.platform !== "win32") return new Map();
  try {
    const { stdout } = await execFileAsync("arp.exe", ["-a"], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const entries = new Map();
    for (const match of stdout.matchAll(/(\\d+\\.\\d+\\.\\d+\\.\\d+)\\s+([0-9a-f-]{17})\\s+(\\w+)/gi)) {
      entries.set(match[1], { macAddress: match[2].toUpperCase(), type: match[3] });
    }
    return entries;
  } catch {
    return new Map();
  }
}

async function resolveHostname(ipAddress) {
  try {
    const names = await dns.reverse(ipAddress);
    if (names.length) return names[0].replace(/\\.$/, "");
  } catch {}
  if (workerData.platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync("nbtstat.exe", ["-A", ipAddress], { timeout: 1800, maxBuffer: 1024 * 64 });
    const match = stdout.match(/^\\s*([^\\s<][^<]{0,14}?)\\s+<00>\\s+UNIQUE/im);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

(async () => {
  const alive = new Set();
  const portsByHost = new Map();
  let scannedHosts = 0;
  await mapLimit(workerData.hosts, 32, async (host) => {
    const openPorts = await scanOpenPorts(host);
    portsByHost.set(host, openPorts);
    if (openPorts.length) alive.add(host);
    scannedHosts += 1;
    parentPort.postMessage({ type: "progress", scannedHosts });
  });

  const arpTable = await readArpTable();
  const subnetMembers = new Set(workerData.hosts);
  for (const ip of arpTable.keys()) {
    if (subnetMembers.has(ip)) alive.add(ip);
  }
  if (workerData.network.ipAddress) alive.add(workerData.network.ipAddress);
  if (workerData.network.gateway) alive.add(workerData.network.gateway);

  const devices = await mapLimit(Array.from(alive).sort((a, b) => ipToInt(a) - ipToInt(b)), 16, async (ip) => {
    const [hostname, openPorts] = await Promise.all([
      resolveHostname(ip),
      portsByHost.has(ip) ? portsByHost.get(ip) : scanOpenPorts(ip),
    ]);
    const arp = arpTable.get(ip);
    return {
      ipAddress: ip,
      hostname,
      macAddress: arp?.macAddress || (ip === workerData.network.ipAddress ? workerData.network.macAddress : null),
      openPorts,
      isLocalHost: ip === workerData.network.ipAddress,
      isGateway: ip === workerData.network.gateway,
    };
  });

  parentPort.postMessage({ type: "complete", devices });
})().catch((error) => {
  parentPort.postMessage({ type: "error", error: error?.message || String(error) });
});
`;

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerScript, {
      eval: true,
      workerData: {
        hosts,
        network,
        ports: IP_SCAN_PORTS,
        labels: PORT_LABELS,
        platform: process.platform,
      },
    });

    worker.on("message", (message) => {
      if (message.type === "progress") {
        ipScanState = { ...ipScanState, scannedHosts: message.scannedHosts };
      }
      if (message.type === "complete") {
        resolve(message.devices);
      }
      if (message.type === "error") {
        reject(new Error(message.error));
      }
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) reject(new Error(`IP scan worker stopped with exit code ${code}.`));
    });
  });
}

async function startIpScan() {
  if (ipScanRunning) return ipScanState;
  ipScanQueued = false;
  ipScanRunning = true;

  ipScanState = {
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    subnet: null,
    range: null,
    scannedHosts: 0,
    totalHosts: 0,
    devices: [],
    error: null,
    message: "Scanning local subnet...",
  };

  try {
    const network = getActiveIpv4Network();
    const ipAddress = network?.ipAddress;
    const prefixLength = network?.prefixLength ?? subnetMaskToPrefix(network?.subnetMask);
    const subnet = subnetHosts(ipAddress, prefixLength);

    if (!subnet?.hosts?.length) {
      throw new Error("No active IPv4 subnet is available to scan.");
    }

    ipScanState = {
      ...ipScanState,
      subnet: subnet.subnet,
      range: subnet.range,
      totalHosts: subnet.hosts.length,
      message: subnet.capped
        ? `Scanning ${subnet.subnet}. Larger subnet was capped to the local /24 for responsiveness.`
        : `Scanning ${subnet.subnet}.`,
    };

    const devices = await runIpScanWorker({ hosts: subnet.hosts, network });

    ipScanState = {
      ...ipScanState,
      status: "complete",
      completedAt: new Date().toISOString(),
      devices,
      message: devices.length ? `Found ${devices.length} device${devices.length === 1 ? "" : "s"} on ${subnet.subnet}.` : `No devices found on ${subnet.subnet}.`,
    };
  } catch (error) {
    ipScanState = {
      ...ipScanState,
      status: "error",
      completedAt: new Date().toISOString(),
      error: errorMessage(error),
      message: "IP scan failed.",
    };
  } finally {
    ipScanRunning = false;
    ipScanQueued = false;
  }

  return ipScanState;
}

function queueIpScan() {
  if (ipScanRunning || ipScanQueued) return ipScanState;
  ipScanQueued = true;
  ipScanState = {
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    subnet: null,
    range: null,
    scannedHosts: 0,
    totalHosts: 0,
    devices: [],
    error: null,
    message: "Starting local subnet scan...",
  };

  setImmediate(() => {
    startIpScan().catch((error) => {
      ipScanRunning = false;
      ipScanQueued = false;
      ipScanState = {
        ...ipScanState,
        status: "error",
        completedAt: new Date().toISOString(),
        error: errorMessage(error),
        message: "IP scan failed.",
      };
    });
  });

  return ipScanState;
}

async function getLldpInfo(adapterName) {
  const psDiscoveryProtocol = await psDiscoveryProtocolStatus();
  if (lastLldpCapture?.status === "complete" && lastLldpCapture.neighbors?.length) {
    return {
      status: "ok",
      source: lastLldpCapture.source,
      neighbors: lastLldpCapture.neighbors,
      lastCapture: lastLldpCapture,
      psDiscoveryProtocol,
    };
  }

  if (!adapterName) {
    return { status: "unavailable", message: "No Ethernet adapter selected.", neighbors: [], psDiscoveryProtocol };
  }

  try {
    const { stdout } = await execFileAsync("lldpcli", ["show", "neighbors", "-f", "json"], {
      timeout: 5000,
      maxBuffer: 1024 * 1024 * 2,
    });
    const data = JSON.parse(stdout);
    return { status: "ok", source: "lldpcli", raw: data, neighbors: extractLldpNeighbors(data), psDiscoveryProtocol };
  } catch (error) {
    return {
      status: "unavailable",
      message: psDiscoveryProtocol.installed
        ? "LLDP capture module is installed. Use Capture to listen for the next LLDP frame."
        : "Install the PSDiscoveryProtocol module to capture LLDP neighbors from Windows.",
      error: error.code === "ENOENT" ? "lldpcli was not found" : error.message,
      neighbors: [],
      lastCapture: lastLldpCapture,
      psDiscoveryProtocol,
    };
  }
}

async function captureLldpNeighbor() {
  if (lldpCaptureRunning) return { status: "running", message: "LLDP capture is already running." };
  lldpCaptureRunning = true;
  lastLldpCapture = { status: "running", startedAt: new Date().toISOString() };

  try {
    const script = `
Import-Module PSDiscoveryProtocol -ErrorAction Stop
$packet = Invoke-DiscoveryProtocolCapture -Type LLDP -Duration 35 -ErrorAction Stop
if ($null -eq $packet) { throw 'No LLDP packet was captured during the 35 second listen window.' }
$data = Get-DiscoveryProtocolData -Packet $packet
$data | ConvertTo-Json -Depth 8 -Compress
`;
    const output = await runPowerShell(script, 45000);
    const parsed = output ? JSON.parse(output) : null;
    const rows = Array.isArray(parsed) ? parsed : [parsed].filter(Boolean);
    lastLldpCapture = {
      status: "complete",
      source: "PSDiscoveryProtocol",
      capturedAt: new Date().toISOString(),
      neighbors: rows.map((row) => ({
        localInterface: firstTextValue(row.Computer, row.Connection, row.Interface),
        systemName: firstTextValue(row.Device, row.SystemName),
        chassisId: firstTextValue(row.ChassisId, row.SourceAddress),
        portId: firstTextValue(row.Port, row.PortId),
        portDescription: firstTextValue(row.PortDescription, row.Description),
        model: firstTextValue(row.Model, row.SystemDescription),
        ipAddress: firstTextValue(row.IPAddress, row.ManagementAddress),
        vlan: firstTextValue(row.VLAN),
      })),
      raw: rows,
    };
  } catch (error) {
    const message = errorMessage(error);
    const noCapture = /No LLDP packet|No packet|timed out|timeout|No MSFT_NetEventPacketCapture|Cannot validate argument on parameter 'Packet'/i.test(message);
    const permissionFailure = /access is denied|administrator|elevat|permission|requested operation requires elevation|HRESULT 0x80041003/i.test(message);
    lastLldpCapture = {
      status: noCapture ? "empty" : "error",
      capturedAt: new Date().toISOString(),
      error: noCapture ? null : message,
      message: noCapture
        ? "No LLDP information was captured during the listen window. This could indicate LLDP is not available on the switch port."
        : permissionFailure
          ? "Local LLDP capture requires running this backend from an elevated PowerShell session."
          : "LLDP capture failed before neighbor information could be read.",
      neighbors: [],
    };
  } finally {
    lldpCaptureRunning = false;
  }

  diagnosticsCache = null;
  return lastLldpCapture;
}

function extractLldpNeighbors(data) {
  const interfaces = data?.lldp?.interface;
  if (!interfaces) return [];
  const list = Array.isArray(interfaces) ? interfaces : [interfaces];
  return list.flatMap((entry) => {
    const chassisItems = Array.isArray(entry.chassis) ? entry.chassis : [entry.chassis].filter(Boolean);
    return chassisItems.map((chassis) => ({
      localInterface: entry.name || entry.interface || null,
      systemName: chassis?.name || null,
      chassisId: chassis?.id?.value || chassis?.id || null,
      portId: chassis?.port?.id?.value || chassis?.port?.id || null,
      portDescription: chassis?.port?.descr || null,
    }));
  });
}

async function collectDiagnostics() {
  const [adapters, ipConfigText] = await Promise.all([getAdapterSnapshot(), getIpConfigText()]);
  const ipConfig = parseIpConfigByAdapter(ipConfigText);
  const discoveredAdapters = adapters.length > 0 ? adapters : adaptersFromIpConfig(ipConfigText);
  const preferred =
    discoveredAdapters.find((adapter) => adapter.Status === "Up" && adapter.IPv4Address) ||
    discoveredAdapters.find((adapter) => adapter.Status === "Up") ||
    discoveredAdapters[0] ||
    null;

  const adapterIpConfig = preferred ? ipConfig.get(String(preferred.Name).toLowerCase()) : null;
  const dhcpServer = adapterIpConfig?.dhcpServer || null;
  const [dhcpServerMac, gatewayMac, lldp] = await Promise.all([
    resolveMacAddress(dhcpServer),
    resolveMacAddress(preferred?.Gateway),
    getLldpInfo(preferred?.Name),
  ]);

  return {
    host: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
    },
    adapter: preferred
      ? {
          name: preferred.Name,
          description: preferred.Description,
          macAddress: preferred.MacAddress,
          status: preferred.Status,
          linkSpeed: preferred.LinkSpeed,
          interfaceIndex: preferred.InterfaceIndex,
          cableConnected: preferred.Status === "Up",
        }
      : null,
    network: preferred
      ? {
          ipAddress: preferred.IPv4Address || null,
          gateway: preferred.Gateway || null,
          subnetMask: preferred.SubnetMask || prefixToSubnetMask(preferred.PrefixLength),
          prefixLength: preferred.PrefixLength ?? null,
          dnsServers: preferred.DnsServers || [],
          dhcpEnabled: preferred.DhcpEnabled || null,
          dhcpServer,
          dhcpServerMac,
          gatewayMac,
          leaseObtained: adapterIpConfig?.leaseObtained || null,
          leaseExpires: adapterIpConfig?.leaseExpires || null,
          dhcpDeviceHint: dhcpServerMac || dhcpServer || gatewayMac || null,
        }
      : null,
    lldp,
    adapters: discoveredAdapters,
    updatedAt: new Date().toISOString(),
  };
}

function speedDownloadUrl(bytes) {
  return `https://speed.cloudflare.com/__down?bytes=${bytes}`;
}

class RateLimitError extends Error {
  constructor(kind, statusCode, retryAfterHeader) {
    const retryAfterMs = parseRetryAfter(retryAfterHeader);
    const retryAt = new Date(Date.now() + retryAfterMs).toISOString();
    super(`${kind} test rate limited. Retrying after ${formatDuration(retryAfterMs)}.`);
    this.name = "RateLimitError";
    this.kind = kind;
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
    this.retryAt = retryAt;
  }
}

function parseRetryAfter(header) {
  if (!header) return 5 * 60 * 1000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(1000, dateMs - Date.now());
  return 5 * 60 * 1000;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes && seconds) return `${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m`;
  return `${seconds}s`;
}

function rateLimitSnapshot() {
  if (!speedtestRateLimitedUntil) return { rateLimitedUntil: null, rateLimitSeconds: 0, rateLimitReason: null };
  const remainingMs = Date.parse(speedtestRateLimitedUntil) - Date.now();
  if (remainingMs <= 0) {
    speedtestRateLimitedUntil = null;
    speedtestRateLimitReason = null;
    return { rateLimitedUntil: null, rateLimitSeconds: 0, rateLimitReason: null };
  }
  return {
    rateLimitedUntil: speedtestRateLimitedUntil,
    rateLimitSeconds: Math.ceil(remainingMs / 1000),
    rateLimitReason: speedtestRateLimitReason,
  };
}

function applyRateLimit(error) {
  if (!(error instanceof RateLimitError)) return;
  speedtestRateLimitedUntil = error.retryAt;
  speedtestRateLimitReason = error.message;
  speedtestNextRunAt = error.retryAt;
}

function httpGetBytes(url, timeoutMs = 15000, expectedBytes = null) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let bytes = 0;
    const request = https.get(url, { timeout: timeoutMs }, (response) => {
      response.on("data", (chunk) => {
        bytes += chunk.length;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          if (response.statusCode === 429) {
            reject(new RateLimitError("Download", response.statusCode, response.headers["retry-after"]));
            return;
          }
          reject(new Error(`Download test returned HTTP ${response.statusCode}.`));
          return;
        }
        if (expectedBytes && bytes < expectedBytes * 0.9) {
          reject(new Error(`Download test returned ${bytes} of ${expectedBytes} bytes.`));
          return;
        }
        resolve({ bytes, durationMs: performance.now() - started, statusCode: response.statusCode });
      });
    });
    request.on("timeout", () => request.destroy(new Error("Speed test timed out.")));
    request.on("error", reject);
  });
}

function errorMessage(error) {
  if (!error) return "Unknown error";
  if (error.message) return error.message;
  if (error.cause?.message) return error.cause.message;
  if (error.code) return error.code;
  return String(error);
}

function firstTextValue(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const nested = firstTextValue(...value);
      if (nested) return nested;
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value === "object") {
      const objectValue = firstTextValue(
        value.IPAddressToString,
        value.ToString,
        value.Address,
        value.value,
        value.Value,
        value.Name,
      );
      if (objectValue) return objectValue;
    }
  }
  return null;
}

function httpPostBytes(url, bytes, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = Buffer.alloc(bytes, 7);
    const started = performance.now();
    const request = https.request(
      {
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": payload.length,
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            if (response.statusCode === 429) {
              reject(new RateLimitError("Upload", response.statusCode, response.headers["retry-after"]));
              return;
            }
            reject(new Error(`Upload test returned HTTP ${response.statusCode}.`));
            return;
          }
          resolve({ bytes: payload.length, durationMs: performance.now() - started, statusCode: response.statusCode });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Upload test timed out.")));
    request.on("error", reject);
    request.end(payload);
  });
}

function mbpsFromResult(result) {
  return (result.bytes * 8) / (result.durationMs / 1000) / 1_000_000;
}

async function adaptiveDownloadTest() {
  const firstBytes = 25_000_000;
  const first = await httpGetBytes(speedDownloadUrl(firstBytes), 20000, firstBytes);
  const firstMbps = mbpsFromResult(first);
  if (firstMbps > 250) {
    const bytes = 95_000_000;
    try {
      return await httpGetBytes(speedDownloadUrl(bytes), 35000, bytes);
    } catch {
      return first;
    }
  }
  return first;
}

async function adaptiveUploadTest() {
  const first = await httpPostBytes("https://speed.cloudflare.com/__up", 8000000, 20000);
  const firstMbps = mbpsFromResult(first);
  if (firstMbps > 300) {
    try {
      return await httpPostBytes("https://speed.cloudflare.com/__up", 64_000_000, 45000);
    } catch {
      return first;
    }
  }
  if (firstMbps > 80) {
    try {
      return await httpPostBytes("https://speed.cloudflare.com/__up", 32_000_000, 35000);
    } catch {
      return first;
    }
  }
  return first;
}

function httpGetJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("http://") ? http : https;
    const request = client.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Public IP lookup timed out.")));
    request.on("error", reject);
  });
}

function publicInfoFromCloudflare(metaValue) {
  return {
    publicIp: metaValue.clientIp || null,
    isp: metaValue.asOrganization || null,
    asn: metaValue.asn || null,
    location: [metaValue.city, metaValue.region, metaValue.country].filter(Boolean).join(", ") || metaValue.colo || null,
  };
}

function publicInfoFromIpInfo(value) {
  return {
    publicIp: value.ip || null,
    isp: value.org || null,
    asn: value.org?.match(/^AS\d+/)?.[0] || null,
    location: [value.city, value.region, value.country].filter(Boolean).join(", ") || null,
  };
}

function publicInfoFromIpApi(value) {
  return {
    publicIp: value.query || null,
    isp: value.isp || value.org || null,
    asn: value.as || null,
    location: [value.city, value.regionName, value.country].filter(Boolean).join(", ") || null,
  };
}

async function lookupPublicIpWithDns() {
  if (process.platform !== "win32") return null;
  const { stdout } = await execFileAsync("nslookup.exe", ["myip.opendns.com", "resolver1.opendns.com"], {
    timeout: 6000,
    maxBuffer: 1024 * 1024,
  });
  const matches = Array.from(stdout.matchAll(/Address:\s*([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/gi)).map((match) => match[1]);
  return matches.find((ip) => ip !== "208.67.222.222") || null;
}

async function lookupPublicNetworkInfo() {
  const errors = [];

  try {
    const info = await httpGetJson("http://ip-api.com/json", 8000);
    if (info.status && info.status !== "success") throw new Error(info.message || "ip-api lookup failed");
    return {
      ...publicInfoFromIpApi(info),
      publicInfoUpdatedAt: new Date().toISOString(),
      publicInfoError: null,
      publicInfoStatus: "complete",
      publicInfoSource: "ip-api.com",
    };
  } catch (error) {
    errors.push(errorMessage(error));
  }

  try {
    const meta = await httpGetJson("https://speed.cloudflare.com/meta", 8000);
    return {
      ...publicInfoFromCloudflare(meta),
      publicInfoUpdatedAt: new Date().toISOString(),
      publicInfoError: null,
      publicInfoStatus: "complete",
      publicInfoSource: "Cloudflare",
    };
  } catch (error) {
    errors.push(errorMessage(error));
  }

  try {
    const info = await httpGetJson("https://ipinfo.io/json", 8000);
    return {
      ...publicInfoFromIpInfo(info),
      publicInfoUpdatedAt: new Date().toISOString(),
      publicInfoError: null,
      publicInfoStatus: "complete",
      publicInfoSource: "ipinfo.io",
    };
  } catch (error) {
    errors.push(errorMessage(error));
  }

  try {
    const ip = await httpGetJson("https://api.ipify.org?format=json", 8000);
    return {
      publicIp: ip.ip || null,
      isp: null,
      asn: null,
      location: null,
      publicInfoUpdatedAt: new Date().toISOString(),
      publicInfoError: null,
      publicInfoStatus: "complete",
      publicInfoSource: "ipify",
    };
  } catch (error) {
    errors.push(errorMessage(error));
  }

  try {
    const publicIp = await lookupPublicIpWithDns();
    if (publicIp) {
      return {
        publicIp,
        isp: null,
        asn: null,
        location: null,
        publicInfoUpdatedAt: new Date().toISOString(),
        publicInfoError: "ISP lookup unavailable, but public IP was found through DNS.",
        publicInfoStatus: "partial",
        publicInfoSource: "OpenDNS",
      };
    }
  } catch (error) {
    errors.push(errorMessage(error));
  }

  return {
    publicIp: null,
    isp: null,
    asn: null,
    location: null,
    publicInfoUpdatedAt: new Date().toISOString(),
    publicInfoError: errors.join("; "),
    publicInfoStatus: "error",
    publicInfoSource: null,
  };
}

function startPublicNetworkLookup(force = false) {
  const now = Date.now();
  const cacheMs = publicNetworkInfo?.publicInfoError ? PUBLIC_INFO_ERROR_CACHE_MS : PUBLIC_INFO_CACHE_MS;
  if (!force && publicNetworkInfo && now - publicNetworkInfoAt < cacheMs) return;
  if (!publicNetworkLookupRunning) {
    publicNetworkLookupStartedAt = now;
    publicNetworkLookupRunning = lookupPublicNetworkInfo()
      .then((info) => {
        publicNetworkInfo = info;
        publicNetworkInfoAt = Date.now();
        return info;
      })
      .finally(() => {
        publicNetworkLookupRunning = null;
      });
  }
}

function getPublicNetworkInfoSnapshot() {
  startPublicNetworkLookup();
  const runningTooLong = publicNetworkLookupRunning && Date.now() - publicNetworkLookupStartedAt > 12000;
  if (!publicNetworkInfo) {
    return {
      publicIp: null,
      isp: null,
      asn: null,
      location: null,
      publicInfoUpdatedAt: null,
      publicInfoError: runningTooLong ? "Public IP lookup is taking longer than expected." : null,
      publicInfoStatus: publicNetworkLookupRunning ? "running" : "idle",
      publicInfoSource: null,
    };
  }
  return {
    ...publicNetworkInfo,
    publicInfoStatus: publicNetworkLookupRunning ? "refreshing" : publicNetworkInfo.publicInfoStatus || "complete",
  };
}

function getSpeedtestSnapshot() {
  const publicInfo = getPublicNetworkInfoSnapshot();
  return {
    ...lastSpeedtest,
    publicIp: lastSpeedtest.publicIp || publicInfo.publicIp,
    isp: lastSpeedtest.isp || publicInfo.isp,
    asn: lastSpeedtest.asn || publicInfo.asn,
    location: lastSpeedtest.location || publicInfo.location,
    publicInfoUpdatedAt: publicInfo.publicInfoUpdatedAt,
    publicInfoError: publicInfo.publicInfoError,
    publicInfoStatus: publicInfo.publicInfoStatus,
    publicInfoSource: publicInfo.publicInfoSource,
    history: speedtestHistory,
    historyStats: getSpeedtestHistoryStats(),
    nextRunAt: speedtestNextRunAt,
    ...rateLimitSnapshot(),
  };
}

function roundMbps(value) {
  return value === null || value === undefined ? null : Number(value.toFixed(1));
}

function statsForHistoryKey(key) {
  const values = speedtestHistory
    .map((sample) => sample[key])
    .filter((value) => typeof value === "number" && Number.isFinite(value));

  if (!values.length) {
    return { high: null, low: null, averageVariance: null, samples: 0 };
  }

  const deltas = values.slice(1).map((value, index) => Math.abs(value - values[index]));
  const averageVariance = deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : 0;

  return {
    high: roundMbps(Math.max(...values)),
    low: roundMbps(Math.min(...values)),
    averageVariance: roundMbps(averageVariance),
    samples: values.length,
  };
}

function getSpeedtestHistoryStats() {
  return {
    download: statsForHistoryKey("downloadMbps"),
    upload: statsForHistoryKey("uploadMbps"),
  };
}

function recordSpeedtestResult(result) {
  if (!result.testedAt) return;
  const last = speedtestHistory.at(-1);
  if (last?.testedAt === result.testedAt) return;
  speedtestHistory = [
    ...speedtestHistory,
    {
      testedAt: result.testedAt,
      status: result.status,
      downloadMbps: result.downloadMbps,
      uploadMbps: result.uploadMbps,
      latencyMs: result.latencyMs,
      error: result.error,
    },
  ].slice(-SPEEDTEST_HISTORY_LIMIT);
}

async function runSpeedtest() {
  if (speedtestRunning) return lastSpeedtest;
  const rateLimit = rateLimitSnapshot();
  if (rateLimit.rateLimitedUntil) {
    lastSpeedtest = {
      ...lastSpeedtest,
      status: "rate_limited",
      ...rateLimit,
      error: `We are rate limited. Waiting ${formatDuration(rateLimit.rateLimitSeconds * 1000)} before the next speedtest.`,
    };
    return lastSpeedtest;
  }
  speedtestRunning = true;
  lastSpeedtest = { ...lastSpeedtest, status: "running", error: null };

  try {
    const latencyStart = performance.now();
    startPublicNetworkLookup(true);
    const latencyProbe = await Promise.allSettled([httpGetBytes(speedDownloadUrl(1), 6000, 1)]).then(
      ([result]) => result,
    );
    const latencyMs = latencyProbe.status === "fulfilled" ? performance.now() - latencyStart : null;
    const [download, upload] = await Promise.allSettled([
      adaptiveDownloadTest(),
      adaptiveUploadTest(),
    ]);
    const downloadResult = download.status === "fulfilled" ? download.value : null;
    const uploadResult = upload.status === "fulfilled" ? upload.value : null;
    const downloadMbps = downloadResult ? mbpsFromResult(downloadResult) : null;
    const uploadMbps = uploadResult ? mbpsFromResult(uploadResult) : null;
    const publicInfoValue = getPublicNetworkInfoSnapshot();
    const errors = [latencyProbe, download, upload]
      .filter((result) => result.status === "rejected")
      .map((result) => {
        applyRateLimit(result.reason);
        return errorMessage(result.reason);
      });
    const rateLimit = rateLimitSnapshot();

    lastSpeedtest = {
      status: rateLimit.rateLimitedUntil
        ? "rate_limited"
        : downloadResult || uploadResult || publicInfoValue.publicIp
          ? "complete"
          : "error",
      downloadMbps: downloadMbps === null ? null : Number(downloadMbps.toFixed(1)),
      uploadMbps: uploadMbps === null ? null : Number(uploadMbps.toFixed(1)),
      latencyMs: latencyMs === null ? null : Number(latencyMs.toFixed(0)),
      publicIp: publicInfoValue.publicIp || null,
      isp: publicInfoValue.isp || null,
      asn: publicInfoValue.asn || null,
      location: publicInfoValue.location || null,
      bytes: downloadResult?.bytes || 0,
      uploadBytes: uploadResult?.bytes || 0,
      durationMs: downloadResult ? Number(downloadResult.durationMs.toFixed(0)) : 0,
      uploadDurationMs: uploadResult ? Number(uploadResult.durationMs.toFixed(0)) : 0,
      testedAt: new Date().toISOString(),
      publicInfoUpdatedAt: publicInfoValue.publicInfoUpdatedAt || null,
      publicInfoError: publicInfoValue.publicInfoError || null,
      publicInfoStatus: publicInfoValue.publicInfoStatus || "idle",
      ...rateLimit,
      error: rateLimit.rateLimitedUntil
        ? `We are rate limited. Waiting ${formatDuration(rateLimit.rateLimitSeconds * 1000)} before the next speedtest.`
        : errors.length
          ? errors.join("; ")
          : null,
    };
    recordSpeedtestResult(lastSpeedtest);
  } catch (error) {
    applyRateLimit(error);
    const rateLimit = rateLimitSnapshot();
    lastSpeedtest = {
      status: rateLimit.rateLimitedUntil ? "rate_limited" : "error",
      downloadMbps: null,
      uploadMbps: null,
      latencyMs: null,
      publicIp: null,
      isp: null,
      asn: null,
      location: null,
      bytes: 0,
      uploadBytes: 0,
      durationMs: 0,
      uploadDurationMs: 0,
      testedAt: new Date().toISOString(),
      publicInfoUpdatedAt: publicNetworkInfo?.publicInfoUpdatedAt || null,
      publicInfoError: publicNetworkInfo?.publicInfoError || null,
      publicInfoStatus: publicNetworkInfo?.publicInfoStatus || "error",
      ...rateLimit,
      error: rateLimit.rateLimitedUntil
        ? `We are rate limited. Waiting ${formatDuration(rateLimit.rateLimitSeconds * 1000)} before the next speedtest.`
        : errorMessage(error),
    };
    recordSpeedtestResult(lastSpeedtest);
  } finally {
    speedtestRunning = false;
  }

  return lastSpeedtest;
}

function scheduleSpeedtestLoop() {
  if (speedtestTimer) clearInterval(speedtestTimer);
  const run = () => {
    const rateLimit = rateLimitSnapshot();
    if (rateLimit.rateLimitedUntil) {
      speedtestNextRunAt = rateLimit.rateLimitedUntil;
      return;
    }
    speedtestNextRunAt = new Date(Date.now() + SPEEDTEST_INTERVAL_MS).toISOString();
    runSpeedtest();
  };
  speedtestNextRunAt = new Date(Date.now() + 1500).toISOString();
  setTimeout(run, 1500).unref();
  speedtestTimer = setInterval(run, SPEEDTEST_INTERVAL_MS);
  speedtestTimer.unref();
}

async function getDiagnosticsCached() {
  const now = Date.now();
  if (diagnosticsCache && now - diagnosticsCacheAt < POLL_CACHE_MS) return diagnosticsCache;
  diagnosticsCache = await collectDiagnostics();
  diagnosticsCacheAt = now;
  return diagnosticsCache;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" });
    res.end();
    return;
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/diagnostics") {
      sendJson(res, 200, await getDiagnosticsCached());
      return;
    }
    if (url.pathname === "/api/speedtest" && req.method === "GET") {
      sendJson(res, 200, getSpeedtestSnapshot());
      return;
    }
    if (url.pathname === "/api/speedtest/run" && req.method === "POST") {
      runSpeedtest();
      sendJson(res, 202, { ...getSpeedtestSnapshot(), status: "running" });
      return;
    }
    if (url.pathname === "/api/public-network/refresh" && req.method === "POST") {
      startPublicNetworkLookup(true);
      sendJson(res, 202, getSpeedtestSnapshot());
      return;
    }
    if (url.pathname === "/api/lldp/install" && req.method === "POST") {
      sendJson(res, 200, await installLldpAgent());
      return;
    }
    if (url.pathname === "/api/lldp/capture" && req.method === "POST") {
      captureLldpNeighbor();
      sendJson(res, 202, { status: "running", message: "Listening for LLDP frames for up to 35 seconds." });
      return;
    }
    if (url.pathname === "/api/ip-scan" && req.method === "GET") {
      sendJson(res, 200, ipScanState);
      return;
    }
    if (url.pathname === "/api/ip-scan/start" && req.method === "POST") {
      sendJson(res, 202, queueIpScan());
      return;
    }
    if (url.pathname === "/api/admin/restart-elevated" && req.method === "POST") {
      sendJson(res, 200, await restartElevated());
      return;
    }
    if (req.method === "GET") {
      await sendStatic(req, res);
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Network diagnostics backend listening on http://localhost:${PORT}`);
  scheduleSpeedtestLoop();
});
