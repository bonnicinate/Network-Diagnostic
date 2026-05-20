import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Cable,
  Download,
  Gauge,
  Globe2,
  LineChart,
  Monitor,
  Network,
  PackagePlus,
  RefreshCw,
  Router,
  SatelliteDish,
  Search,
  Server,
  Shield,
  ShieldAlert,
  Upload,
  WifiOff,
} from "lucide-react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4317";

function usePolling(path, intervalMs) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const json = await response.json();
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }

    load();
    const timer = window.setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [path, intervalMs]);

  return { data, error };
}

function formatDate(value) {
  if (!value) return "Unavailable";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function Metric({ icon: Icon, label, value, hint }) {
  return (
    <section className="metric">
      <div className="metricIcon">
        <Icon size={28} strokeWidth={1.8} />
      </div>
      <div>
        <p>{label}</p>
        <strong>{value || "Unavailable"}</strong>
        {hint ? <span>{hint}</span> : null}
      </div>
    </section>
  );
}

function StatusPill({ connected }) {
  return (
    <div className={connected ? "statusPill online" : "statusPill offline"}>
      {connected ? <Cable size={18} /> : <WifiOff size={18} />}
      <span>{connected ? "Cable connected" : "Cable removed"}</span>
    </div>
  );
}

function Speedtest({ speed }) {
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!speed?.rateLimitedUntil) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [speed?.rateLimitedUntil]);

  async function rerun() {
    if (isRateLimitedUntil(speed?.rateLimitedUntil, now)) return;
    setBusy(true);
    try {
      await fetch(`${API_BASE}/api/speedtest/run`, { method: "POST" });
    } finally {
      window.setTimeout(() => setBusy(false), 900);
    }
  }

  const running = busy || speed?.status === "running";
  const localRateLimitSeconds = secondsUntil(speed?.rateLimitedUntil, now);
  const rateLimited = localRateLimitSeconds > 0;
  const hasSpeedResult = Boolean(speed?.testedAt);
  const publicLookupActive = speed?.publicInfoStatus === "running" || speed?.publicInfoStatus === "refreshing";
  const publicIpText = speed?.publicIp
    ? `Public IP ${speed.publicIp}`
    : speed?.publicInfoError
      ? "Public IP lookup failed"
      : publicLookupActive
        ? "Looking up public IP"
        : "Checking public IP";
  const ispText = speed?.isp
    ? `ISP ${speed.isp}`
    : speed?.publicInfoError
      ? "ISP lookup failed"
      : publicLookupActive
        ? "Looking up ISP"
        : "Checking ISP";
  const speedWarning = rateLimited
    ? `We are rate limited, waiting ${formatSeconds(localRateLimitSeconds)} before the next speedtest.`
    : speed?.error || speed?.publicInfoError;
  const rateLimitTitle = rateLimited
    ? `Rate limited at ${new Date(now).toLocaleTimeString()}. Retry at ${formatDate(speed.rateLimitedUntil)}. Waiting ${formatSeconds(localRateLimitSeconds)}.`
    : undefined;

  return (
    <section className="speedPanel">
      <div className="panelTitle">
        <Gauge size={30} />
        <div>
          <p>Speedtest</p>
          <strong>{speed?.downloadMbps ? `${speed.downloadMbps}` : "Not run"}</strong>
          {speed?.downloadMbps ? <span>Mbps down</span> : null}
        </div>
      </div>
      <div className="speedStats">
        <div>
          <Download size={18} />
          <span>{speed?.downloadMbps ? `${speed.downloadMbps} Mbps` : "Down unavailable"}</span>
        </div>
        <div>
          <Upload size={18} />
          <span>{speed?.uploadMbps ? `${speed.uploadMbps} Mbps` : "Up unavailable"}</span>
        </div>
        <div>
          <Activity size={18} />
          <span>{speed?.latencyMs ? `${speed.latencyMs} ms` : "Latency unavailable"}</span>
        </div>
      </div>
      <span className="buttonShell" title={rateLimitTitle}>
        <button className={rateLimited ? "touchButton rateLimited" : "touchButton"} type="button" onClick={rerun} disabled={running || rateLimited}>
          <RefreshCw className={running ? "spin" : ""} size={24} />
          <span>{rateLimited ? `Waiting ${formatSeconds(localRateLimitSeconds)}` : running ? "Testing" : "Rerun"}</span>
        </button>
      </span>
      <div className="speedDetails">
        <span>{publicIpText}</span>
        <span>{ispText}</span>
        <span>
          {hasSpeedResult
            ? `Last ${formatDate(speed.testedAt)}`
            : speed?.publicInfoSource
              ? `Source ${speed.publicInfoSource}`
              : "Run speedtest for throughput"}
        </span>
      </div>
      {speedWarning ? <div className="warning">{speedWarning}</div> : null}
    </section>
  );
}

function formatSeconds(value) {
  const total = Math.max(1, Number(value) || 1);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes && seconds) return `${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m`;
  return `${seconds}s`;
}

function secondsUntil(value, now = Date.now()) {
  if (!value) return 0;
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return 0;
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}

function isRateLimitedUntil(value, now = Date.now()) {
  return secondsUntil(value, now) > 0;
}

function LldpPanel({ lldp }) {
  const [installing, setInstalling] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [actionStatus, setActionStatus] = useState(null);
  const capture = lldp?.lastCapture;
  const neighbors = lldp?.neighbors?.length ? lldp.neighbors : capture?.neighbors || [];
  const moduleInstalled = Boolean(lldp?.psDiscoveryProtocol?.installed);
  const elevated = Boolean(lldp?.psDiscoveryProtocol?.elevated);

  useEffect(() => {
    if (!capture?.status || capture.status === "running") return;
    setCapturing(false);
    if (capture.status === "complete") {
      setActionStatus(capture.neighbors?.length ? "LLDP neighbor captured." : "LLDP capture completed with no neighbor details.");
      return;
    }
    setActionStatus(capture.message || capture.error || "LLDP capture finished.");
  }, [capture?.status, capture?.capturedAt, capture?.message, capture?.error, capture?.neighbors?.length]);

  async function installAgent() {
    setInstalling(true);
    setActionStatus("Installing PSDiscoveryProtocol...");
    try {
      const response = await fetch(`${API_BASE}/api/lldp/install`, { method: "POST" });
      const result = await response.json();
      setActionStatus(result.status === "complete" ? "LLDP module installed." : result.error || result.message);
    } catch (error) {
      setActionStatus(error.message);
    } finally {
      setInstalling(false);
    }
  }

  async function captureNeighbor() {
    setCapturing(true);
    setActionStatus("Listening for LLDP frames...");
    try {
      await fetch(`${API_BASE}/api/lldp/capture`, { method: "POST" });
      window.setTimeout(() => setCapturing(false), 36000);
    } catch (error) {
      setActionStatus(error.message);
      setCapturing(false);
    }
  }

  async function restartElevated() {
    setRestarting(true);
    setActionStatus("Opening Windows UAC prompt...");
    try {
      const response = await fetch(`${API_BASE}/api/admin/restart-elevated`, { method: "POST" });
      const result = await response.json();
      setActionStatus(result.message || "Restarting elevated backend...");
      window.setTimeout(() => {
        window.location.reload();
      }, 5000);
    } catch (error) {
      setActionStatus(error.message);
      setRestarting(false);
    }
  }

  return (
    <section className="lldpPanel">
      <div className="panelHeader">
        <div className="sectionHeading">
          <SatelliteDish size={24} />
          <h2>LLDP neighbor</h2>
        </div>
        <div className="buttonRow">
          <button className="iconButton" type="button" onClick={installAgent} disabled={installing || moduleInstalled}>
            <PackagePlus size={20} />
            <span>{moduleInstalled ? "Installed" : installing ? "Installing" : "Install agent"}</span>
          </button>
          <button className="iconButton" type="button" onClick={restartElevated} disabled={restarting || elevated}>
            <Shield size={20} />
            <span>{elevated ? "Elevated" : restarting ? "Restarting" : "Restart elevated"}</span>
          </button>
          <button className="iconButton" type="button" onClick={captureNeighbor} disabled={capturing || !moduleInstalled || !elevated}>
            <RefreshCw className={capturing ? "spin" : ""} size={20} />
            <span>{capturing ? "Capturing" : "Capture"}</span>
          </button>
        </div>
      </div>
      {neighbors.length > 0 ? (
        <div className="neighborGrid">
          {neighbors.map((neighbor, index) => (
            <div className="neighbor" key={`${neighbor.chassisId}-${index}`}>
              <strong>{neighbor.systemName || neighbor.chassisId || "Neighbor detected"}</strong>
              <span>Port {neighbor.portDescription || neighbor.portId || "Unknown"}</span>
              <span>Local {neighbor.localInterface || "Unknown"}</span>
              {neighbor.ipAddress ? <span>IP {neighbor.ipAddress}</span> : null}
              {neighbor.vlan ? <span>VLAN {neighbor.vlan}</span> : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="emptyState">
          <ShieldAlert size={28} />
          <span>
            {capture?.message ||
              capture?.error ||
              actionStatus ||
              (!elevated && moduleInstalled ? "Restart elevated to allow local LLDP packet capture." : lldp?.message) ||
              "No LLDP neighbor information available."}
          </span>
        </div>
      )}
      {actionStatus && neighbors.length > 0 ? <div className="inlineStatus">{actionStatus}</div> : null}
    </section>
  );
}

function StatChip({ label, value, suffix = "Mbps" }) {
  return (
    <span>
      {label} {value === null || value === undefined ? "..." : `${value} ${suffix}`}
    </span>
  );
}

function SpeedHistoryChart({ history = [], stats, nextRunAt }) {
  const points = history.filter((sample) => sample.downloadMbps || sample.uploadMbps).slice(-60);
  const maxSpeed = Math.max(10, ...points.flatMap((sample) => [sample.downloadMbps || 0, sample.uploadMbps || 0]));
  const width = 760;
  const height = 220;
  const pad = 18;
  const plotWidth = width - pad * 2;
  const plotHeight = height - pad * 2;

  const lineFor = (key) =>
    points
      .map((sample, index) => {
        const x = pad + (points.length <= 1 ? plotWidth : (index / (points.length - 1)) * plotWidth);
        const y = pad + plotHeight - ((sample[key] || 0) / maxSpeed) * plotHeight;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  const latest = points.at(-1);
  const downloadStats = stats?.download || {};
  const uploadStats = stats?.upload || {};

  return (
    <section className="historyPanel">
      <div className="panelHeader">
        <div className="sectionHeading">
          <LineChart size={24} />
          <h2>Speed history</h2>
        </div>
        <div className="historySummary">
          <span>{latest?.downloadMbps ? `${latest.downloadMbps} Mbps down` : "Waiting for first test"}</span>
          <span>{latest?.uploadMbps ? `${latest.uploadMbps} Mbps up` : nextRunAt ? `Next ${formatDate(nextRunAt)}` : "Runs every minute"}</span>
        </div>
      </div>
      <div className="chartFrame">
        {points.length > 1 ? (
          <svg className="speedChart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Download and upload speed history">
            <line x1={pad} y1={pad} x2={pad} y2={height - pad} />
            <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} />
            <polyline className="downloadLine" points={lineFor("downloadMbps")} />
            <polyline className="uploadLine" points={lineFor("uploadMbps")} />
          </svg>
        ) : (
          <div className="chartEmpty">Collecting the first minute of speed samples.</div>
        )}
      </div>
      <div className="statsGrid">
        <div>
          <strong>Download</strong>
          <StatChip label="High" value={downloadStats.high} />
          <StatChip label="Low" value={downloadStats.low} />
          <StatChip label="Avg variance" value={downloadStats.averageVariance} />
        </div>
        <div>
          <strong>Upload</strong>
          <StatChip label="High" value={uploadStats.high} />
          <StatChip label="Low" value={uploadStats.low} />
          <StatChip label="Avg variance" value={uploadStats.averageVariance} />
        </div>
      </div>
      <div className="legendRow">
        <span className="legendItem download">Download</span>
        <span className="legendItem upload">Upload</span>
        <span>Peak scale {Math.ceil(maxSpeed)} Mbps</span>
      </div>
    </section>
  );
}

function IpScanner({ scan }) {
  const [starting, setStarting] = useState(false);
  const running = starting || scan?.status === "running";
  const devices = scan?.devices || [];
  const totalHosts = scan?.totalHosts || 0;
  const scannedHosts = scan?.scannedHosts || 0;
  const progress = totalHosts ? Math.min(100, Math.round((scannedHosts / totalHosts) * 100)) : 0;

  async function startScan() {
    setStarting(true);
    try {
      await fetch(`${API_BASE}/api/ip-scan/start`, { method: "POST" });
    } finally {
      window.setTimeout(() => setStarting(false), 900);
    }
  }

  return (
    <section className="scannerPanel">
      <div className="panelHeader">
        <div className="sectionHeading">
          <Search size={24} />
          <h2>IP scanner</h2>
        </div>
        <button className="iconButton" type="button" onClick={startScan} disabled={running}>
          <RefreshCw className={running ? "spin" : ""} size={20} />
          <span>{running ? "Scanning" : "Scan network"}</span>
        </button>
      </div>

      <div className="scannerSummary">
        <div>
          <span>Subnet</span>
          <strong>{scan?.subnet || "Waiting for scan"}</strong>
        </div>
        <div>
          <span>Range</span>
          <strong>{scan?.range || "Unavailable"}</strong>
        </div>
        <div>
          <span>Devices</span>
          <strong>{devices.length}</strong>
        </div>
      </div>

      {running ? (
        <div className="scanProgress" aria-label="Scan progress">
          <span style={{ width: `${progress}%` }} />
        </div>
      ) : null}

      <div className={scan?.error ? "warning" : "inlineStatus"}>{scan?.error || scan?.message || "Run a scan to discover devices."}</div>

      {devices.length ? (
        <div className="deviceTable">
          <div className="deviceHeader">
            <span>Device</span>
            <span>Address</span>
            <span>Open ports</span>
          </div>
          {devices.map((device) => (
            <div className="deviceRow" key={device.ipAddress}>
              <div className="deviceName">
                <Monitor size={20} />
                <div>
                  <strong>{device.hostname || "Unknown host"}</strong>
                  <span>{[device.isLocalHost ? "This computer" : null, device.isGateway ? "Gateway" : null].filter(Boolean).join(" / ") || "Network device"}</span>
                </div>
              </div>
              <div>
                <strong>{device.ipAddress}</strong>
                <span>{device.macAddress || "MAC unavailable"}</span>
              </div>
              <div className="portList">
                {device.openPorts?.length ? (
                  device.openPorts.map((entry) =>
                    entry.webAvailable && entry.url ? (
                      <a className="portLink" key={`${device.ipAddress}-${entry.port}`} href={entry.url} target="_blank" rel="noreferrer">
                        {entry.port} {entry.service} 200
                      </a>
                    ) : (
                      <span key={`${device.ipAddress}-${entry.port}`}>
                        {entry.port} {entry.service}
                        {entry.httpStatus ? ` ${entry.httpStatus}` : ""}
                      </span>
                    ),
                  )
                ) : (
                  <span>No common ports open</span>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="emptyState">
          <ShieldAlert size={28} />
          <span>{running ? `Scanned ${scannedHosts} of ${totalHosts || "..."} hosts.` : "No scan results yet."}</span>
        </div>
      )}
    </section>
  );
}

function App() {
  const { data: diagnostics, error } = usePolling("/api/diagnostics", 2000);
  const { data: speed } = usePolling("/api/speedtest", 1200);
  const { data: scan } = usePolling("/api/ip-scan", 1200);
  const [activeView, setActiveView] = useState("dashboard");
  const adapter = diagnostics?.adapter;
  const network = diagnostics?.network;
  const connected = Boolean(adapter?.cableConnected);
  const adapterTitle = adapter?.description || adapter?.name || "Ethernet adapter";
  const adapterSubtitle = adapter?.name
    ? `Interface ${adapter.name}${adapter.macAddress ? ` · MAC ${adapter.macAddress}` : ""}${adapter.interfaceIndex !== undefined ? ` · Index ${adapter.interfaceIndex}` : ""}`
    : "Waiting for adapter data";

  const dhcpHint = useMemo(() => {
    if (network?.dhcpServerMac) return `DHCP server MAC ${network.dhcpServerMac}`;
    if (network?.dhcpServer) return `DHCP server ${network.dhcpServer}`;
    if (network?.gatewayMac) return `Gateway MAC ${network.gatewayMac}`;
    return "Awaiting lease source";
  }, [network]);

  return (
    <main className="appShell">
      <header className="topBar">
        <div className="brandLockup">
          <img src="/bws-logo.svg" alt="Bonnici Web Services" />
          <div>
            <p className="eyebrow">Network diagnostics</p>
            <h1>{adapterTitle}</h1>
            <p className="headerDetail">{adapterSubtitle}</p>
          </div>
        </div>
        <StatusPill connected={connected} />
      </header>

      <nav className="viewTabs" aria-label="Network diagnostic views">
        <button type="button" className={activeView === "dashboard" ? "active" : ""} onClick={() => setActiveView("dashboard")}>
          <Activity size={18} />
          <span>Dashboard</span>
        </button>
        <button type="button" className={activeView === "scanner" ? "active" : ""} onClick={() => setActiveView("scanner")}>
          <Search size={18} />
          <span>IP scanner</span>
        </button>
      </nav>

      {error ? <div className="appError">Backend unavailable: {error}</div> : null}

      {activeView === "dashboard" ? (
        <>
          <section className="heroBand">
            <div>
              <p>{adapter?.description || diagnostics?.host?.hostname || "Waiting for adapter data"}</p>
              <strong>{adapter?.linkSpeed || "Link speed unavailable"}</strong>
            </div>
            <Activity size={64} />
          </section>

          <div className="dashboardGrid">
            <Speedtest speed={speed} />
            <div className="metricGrid">
              <Metric icon={Server} label="DHCP lease IP" value={network?.ipAddress} hint={formatDate(network?.leaseExpires)} />
              <Metric icon={Router} label="Gateway" value={network?.gateway} hint={network?.gatewayMac ? `MAC ${network.gatewayMac}` : "No gateway MAC"} />
              <Metric icon={Network} label="Subnet mask" value={network?.subnetMask} hint={network?.prefixLength ? `/${network.prefixLength}` : null} />
              <Metric icon={Cable} label="Lease source" value={network?.dhcpServer || network?.dhcpDeviceHint} hint={dhcpHint} />
              <Metric icon={Globe2} label="Public IP" value={speed?.publicIp} hint={speed?.isp || speed?.publicInfoError || "Looking up"} />
            </div>
          </div>

          <LldpPanel lldp={diagnostics?.lldp} />
          <SpeedHistoryChart history={speed?.history} stats={speed?.historyStats} nextRunAt={speed?.nextRunAt} />
        </>
      ) : (
        <div className="scannerView">
          <IpScanner scan={scan} />
        </div>
      )}
      <footer className="appFooter">
        <a href="https://bonniciwebservices.com.au" target="_blank" rel="noreferrer" aria-label="Bonnici Web Services">
          <img src="/bws-logo.svg" alt="" aria-hidden="true" />
        </a>
        <span>Built by Nate Bonnici, 2026</span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
