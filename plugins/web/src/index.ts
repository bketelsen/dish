/**
 * dish-web: settings over the tailnet.
 *
 * dsh counts a page as "the operator's own machine" only when it is on a loopback address, or when dsh's desktop shell
 * has set the transport global `__DSH_TRANSPORT__.ownsHost`. On any other page, such as `https://<tailnet name>`, host
 * settings are unavailable (the Models page fails) and UI preferences are kept in memory only. The server never makes
 * that check: it is made in the browser, from `location.hostname`. A request that passes the Host check
 * (`--trusted-host`) and carries the sign-in cookie can already write settings and credentials.
 *
 * This plugin adds one classic script row to the head of the page, through dsh's `webserver/index-inject` hook. When it
 * runs, it sets `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }` if the page's hostname is one of the trusted hosts
 * and no transport global is there already. Only `isLoopback` changes. The trusted hosts are the non-IP entries of
 * `webRuntime.trustedHosts` (dsh's web app provides `webRuntime`), unless `hosts` says otherwise.
 *
 * It does nothing, and registers nothing, unless `enabled` is true, `webRuntime` is there (a profile other than the web
 * one has none) and there is at least one host.
 *
 * The risk is a dependency on a field that only dsh's shell is meant to set: `test/pin.test.ts` reads the installed
 * `dsh-client-connection` and fails when it no longer decides `isLoopback` that way.
 *
 * @module dish-web
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dish-web'

export interface Config {
  enabled: boolean
  hosts: string[]
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true)
    .description('Let pages on the trusted hosts (--trusted-host, DNS names only) use settings and keep UI preferences, as pages on this machine do.'),
  hosts: Schema.array(String).default([])
    .description('The page hosts to do that for, instead of the DNS names among the trusted hosts: bare DNS names, with no port and no IP address. Leave empty to use the trusted hosts.'),
})

/** One label of a DNS name: letters and digits, and hyphens inside. */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const DNS_NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`)
/** A last label the URL parser reads as a number: `1.2.3.4`, `1.2`, `0x7f` and the like are IP addresses, not names. */
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/

/** Whether `host` (already lower case) is a bare DNS name, and not an IP address in any of the forms a URL accepts. */
function isDnsName(host: string): boolean {
  if (host.length > 253 || !DNS_NAME.test(host)) return false
  return !NUMERIC_LABEL.test(host.slice(host.lastIndexOf('.') + 1))
}

/** The DNS name in a trusted-host entry (`host` or `host:port`), lower case and without the port, or `undefined` if it is not one. */
function pageHostOf(entry: string): string | undefined {
  const text = entry.trim().toLowerCase()
  const colon = text.indexOf(':')
  if (colon !== text.lastIndexOf(':')) return undefined // an IPv6 literal without brackets
  let host = text
  if (colon >= 0) {
    if (!/^\d{1,5}$/.test(text.slice(colon + 1))) return undefined
    host = text.slice(0, colon)
  }
  return isDnsName(host) ? host : undefined
}

/**
 * The hosts whose pages count as the operator's machine: lower case, without a port, no duplicates, in order.
 *
 * With `override` empty these are the DNS names among `trustedHosts`; IP addresses (IPv4, IPv6, bracketed or not) and
 * anything else that isn't a name are left out. With `override`, they are the override and nothing else, and every entry
 * has to be a bare DNS name.
 * @throws a plain `Error` naming the first `override` entry that is not a bare DNS name (an IP address, a port, a scheme, ...).
 */
export function trustedPageHosts(trustedHosts: readonly string[], override: readonly string[]): string[] {
  const hosts = new Set<string>()
  if (override.length > 0) {
    for (const entry of override) {
      const host = entry.trim().toLowerCase()
      if (!isDnsName(host)) {
        throw new Error(`dish-web: hosts entry ${JSON.stringify(entry)} is not a bare DNS name (lower-case letters, digits, '-' and '.', with no port and no IP address)`)
      }
      hosts.add(host)
    }
  } else {
    for (const entry of trustedHosts) {
      const host = pageHostOf(entry)
      if (host !== undefined) hosts.add(host)
    }
  }
  return [...hosts].sort()
}

/**
 * The classic script that makes the page's `isLoopback` true on one of `hosts`: it sets `globalThis.__DSH_TRANSPORT__ =
 * { ownsHost: true }` when the page's lower-cased hostname is listed and nothing has set the global. It does nothing
 * otherwise, and it never throws. The text has no `</script`: the hosts are embedded as a JSON array with `<` escaped.
 */
export function flipScript(hosts: readonly string[]): string {
  const list = JSON.stringify(hosts).replaceAll('<', '\\u003c')
  return `(function(){try{if(${list}.indexOf(location.hostname.toLowerCase())>=0&&globalThis.__DSH_TRANSPORT__===undefined)globalThis.__DSH_TRANSPORT__={ownsHost:true}}catch(e){}})()`
}

/** `webRuntime.trustedHosts` as the web app provides it, or an empty list for anything else. */
function trustedHostsOf(runtime: unknown): string[] {
  const hosts = (runtime as { trustedHosts?: unknown } | null | undefined)?.trustedHosts
  return Array.isArray(hosts) ? hosts.filter((host): host is string => typeof host === 'string') : []
}

/**
 * Add the script row to the page, for as long as `webRuntime` is there.
 * @throws a plain `Error` for a `hosts` entry that is not a bare DNS name.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const logger = ctx.logger(name)
  // Checked now, so that a bad setting fails the plugin to load and not only the web profile's start.
  trustedPageHosts([], config.hosts)

  // `webRuntime` is dsh's web app's: it is provided once the server is bound, and a profile without it has no page to serve.
  // The listener is registered through the child context, so it goes when the service does, or this plugin.
  ctx.inject(['webRuntime'], (child) => {
    const runtime = (child as unknown as { get(name: string): unknown }).get('webRuntime')
    const hosts = trustedPageHosts(trustedHostsOf(runtime), config.hosts)
    if (hosts.length === 0) {
      logger.info('no DNS name among the trusted hosts, so pages stay as they are')
      return
    }
    const row: IndexInjection = { kind: 'script', placement: 'head', text: flipScript(hosts) }
    child.on('webserver/index-inject', (table) => { table.push({ ...row }) }, { prepend: true })
    logger.info('pages on %s count as this machine', hosts.join(', '))
  })
}
