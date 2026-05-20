# Network Diagnostic

A local Windows-focused network diagnostics dashboard built with React and a Node.js backend.

The app is designed for quick touch-friendly troubleshooting on an Ethernet-connected machine. It displays live adapter details, DHCP lease information, gateway/subnet details, public IP/ISP information, speedtest history, and optional LLDP neighbor capture.

## Features

- Dark, touch-friendly React interface.
- Local Node.js backend served from the same port as the frontend.
- One-click Windows launchers, including an elevated launcher for LLDP capture.
- Live Ethernet adapter status with cable connected/removed detection.
- DHCP lease IP address, DHCP server, DHCP/gateway MAC, gateway, subnet mask, DNS, lease expiry.
- Public IP, ISP/ASN, and location lookup.
- Automatic speedtest shortly after startup.
- Scheduled speedtest every minute.
- Adaptive speedtest payloads for faster connections.
- Rate-limit handling for speedtest endpoints, including Retry-After countdowns.
- Download/upload speed history graph.
- Peak high, peak low, and average variance between tests.
- LLDP capture using `PSDiscoveryProtocol` on Windows.
- Local subnet IP scanner with hostname lookup and common TCP port checks.
- Branded footer and favicon.

## Screens / Data Shown

The dashboard currently includes:

- Active Ethernet adapter description.
- Interface name, MAC address, and interface index.
- Cable connection status.
- Link speed when Windows exposes it.
- DHCP lease IP.
- Gateway address and gateway MAC.
- Subnet mask.
- DHCP lease source and DHCP server MAC.
- Public IP and ISP details.
- Download, upload, and latency.
- Speed history chart.
- LLDP neighbor details when captured.
- IP scanner results on a separate tab, including detected devices, hostnames, MAC addresses, and open common ports.

## Requirements

- Windows 10/11.
- Node.js and npm.
- PowerShell.
- For LLDP capture: elevated permissions and the `PSDiscoveryProtocol` PowerShell module.

The app can run without elevation for most diagnostics. LLDP packet capture requires elevation because Windows restricts packet capture/network event tracing.

## Quick Start

Double-click one of the launchers:

- `Launch Network Diagnostic.cmd`
- `Launch Network Diagnostic Elevated.cmd`
- `Launch Network Diagnostic.ps1`
- `Launch Network Diagnostic Elevated.ps1`

Use the elevated launcher when you want LLDP capture available immediately.

The app opens at:

```text
http://localhost:4317
```

## CLI Usage

If `npm` is not visible in your current PowerShell session, prepend the standard Node.js install folder before running npm:

```powershell
$env:PATH = "C:\Program Files\nodejs;$env:PATH"
```

Install dependencies:

```powershell
npm install
```

Run the app:

```powershell
npm run dev
```

Or run with the explicit npm path:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run dev
```

Build the frontend:

```powershell
npm run build
```

Run only the backend:

```powershell
npm run dev:backend
```

## LLDP Capture

LLDP capture is handled through the `PSDiscoveryProtocol` PowerShell module.

Recommended flow in the app:

1. Click **Install agent** if the module is not installed.
2. Click **Restart elevated** if the backend is not elevated.
3. Click **Capture** to listen for LLDP frames.

If no LLDP packet is captured, the app reports:

```text
No LLDP information was captured during the listen window. This could indicate LLDP is not available on the switch port.
```

That can mean:

- LLDP is disabled globally on the switch.
- LLDP is disabled on the specific switch port.
- The connected device does not advertise LLDP.
- The capture window did not overlap with an LLDP advertisement interval.

## Speedtest Behaviour

The backend automatically runs a speedtest shortly after startup and then once per minute.

The test uses Cloudflare's speedtest endpoints:

- Download: `https://speed.cloudflare.com/__down`
- Upload: `https://speed.cloudflare.com/__up`

The first payload is intentionally moderate. If the measured speed is high, the backend retries with a larger payload for a more stable reading.

If the speedtest endpoint returns HTTP `429`, the backend reads `Retry-After`, pauses scheduled tests until the retry time, and the UI shows a countdown. The rerun button is greyed out and disabled while rate-limited.

## Public IP / ISP Lookup

The app tries several sources for public network metadata:

1. `http://ip-api.com/json`
2. `https://speed.cloudflare.com/meta`
3. `https://ipinfo.io/json`
4. `https://api.ipify.org?format=json`
5. Windows DNS fallback via OpenDNS

The public lookup runs independently from the throughput test so the UI does not block if an external service is slow or unavailable.

## Backend API

The backend listens on port `4317` by default.

### `GET /api/diagnostics`

Returns:

- Host platform.
- Active/preferred Ethernet adapter.
- DHCP/network details.
- LLDP status and capture results.
- Adapter list.

### `GET /api/speedtest`

Returns:

- Current speedtest status.
- Latest download/upload/latency values.
- Public IP/ISP details.
- Rate-limit details.
- Speed history.
- Speed history stats.
- Next scheduled run time.

### `POST /api/speedtest/run`

Starts a manual speedtest unless a test is already running or the speedtest endpoint is rate-limited.

### `POST /api/public-network/refresh`

Starts a public IP/ISP metadata refresh.

### `POST /api/lldp/install`

Installs `PSDiscoveryProtocol` for the current user.

### `POST /api/lldp/capture`

Starts an LLDP capture window.

### `GET /api/ip-scan`

Returns the latest IP scanner status and results.

### `POST /api/ip-scan/start`

Starts a local subnet scan. The scanner probes common TCP ports on the active IPv4 subnet, merges Windows ARP entries, resolves hostnames where available, and reports open ports including HTTP, HTTPS, SMB, RDP, SSH, DNS, printer, and alternate web ports.

### `POST /api/admin/restart-elevated`

Triggers a Windows UAC prompt and restarts the backend elevated.

## Project Structure

```text
.
├── public/
│   └── bws-logo.svg
├── server/
│   └── index.mjs
├── src/
│   ├── App.jsx
│   └── styles.css
├── Launch Network Diagnostic.cmd
├── Launch Network Diagnostic Elevated.cmd
├── index.html
├── package.json
└── README.md
```

## Public Repository Notes

This repository should not include local generated folders:

- `node_modules/`
- `.npm-cache/`
- `dist/`

Those are ignored by `.gitignore`.

The included branding assets are:

- `bws-logo.png`
- `public/bws-logo.svg`

Remove or replace those before publishing if the branding should not be public.

## Known Limitations

- LLDP capture is Windows-focused and depends on PowerShell plus elevated permissions.
- The IP scanner scans the active local IPv4 subnet only. Larger networks are capped to the local `/24` to keep the scan responsive.
- Speedtest results depend on remote endpoint availability and rate limits.
- Speedtest history is stored in memory and resets when the backend restarts.
- The backend currently prefers Ethernet-like adapters and may need refinement for unusual NIC names.

## Credits

Built by Nate Bonnici, 2026.
