# dish-web

Makes Settings work over the tailnet, as it does on `http://127.0.0.1`.

dsh treats only loopback pages as the operator's own machine. On `https://<tailnet name>`, host settings are unavailable (the Models page says "settings are unavailable in this browser") and UI preferences, such as Work details, are kept in memory only. This plugin tells the page that it is on the operator's machine when it is served from one of your trusted hosts.

- **What it does.** It adds one small script to the page's `<head>`, through dsh's `webserver/index-inject` hook. On a page whose hostname is a trusted host, and only when nothing has set it already, the script sets `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }`. dsh's browser code then reports itself as loopback. The connection, the stream URL and module loading stay as they were.
- **Which hosts.** The DNS names among the web app's trusted hosts (`dsh web --trusted-host <name>`; the VM's unit gets it from `deploy.env`). IP addresses are left out, and so are ports. With no trusted host, or outside the web profile, it does nothing.
- **What you get.** Durable Work details and other preferences, a working Models page (so the Copilot sign-in card is reachable), and every settings page saves. "Open configuration file" appears too. On a headless VM it does nothing useful, and it is harmless.
- **What it doesn't change.** It allows no request that was refused before. Anyone who passes the Host check and holds the sign-in cookie could already write settings and credentials. One thing does change: every browser on that host now writes the one shared settings document.

## Install

```sh
pnpm dsh plugin --profile web add ./plugins/web
```

`deploy/install.sh` links it with the other bundles. It has no client half.

## Config

On the `dish-web` row of the profile's `cordis.patch.yml`:

```yaml
- id: dish-web
  name: dish-web
  config:
    enabled: true          # false: do nothing
    hosts: [dish.example]  # bare DNS names; replaces the list derived from the trusted hosts
```

A `hosts` entry that is an IP address or has a port fails the plugin to load, with the entry named.

## The risk

The check lives in the browser, and `ownsHost` is a field that dsh's desktop shell sets: dsh's own documentation says served pages never carry it. A later dsh could give it other meanings. `test/pin.test.ts` reads the installed `@deepseek-ai/dsh-client-connection` and fails when its `isLoopback` computation no longer includes `transport?.ownsHost === true`, so that a dsh upgrade has to re-check this plugin. The reasoning is in the [ops spec](../../docs/specs/ops.md), under "Settings over the tailnet".
