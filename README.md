# ZGAP for magpie

A [magpie](https://usemagpie.ai) plugin that signs in to ZGAP (`https://ai-proxy.zz.gg`) and lets every
agent magpie serves (Claude Code, Codex, OpenCode and the rest) use ZGAP's models.

## Install

```sh
magpie plugin add github:kargnas/zgap-magpie-plugin
```

It is also listed in the magpie app under Plugins → Discover → Unofficial.

## Sign in

```sh
magpie plugin login zgap
```

Or add a ZGAP account in the app. A ZGAP page opens in your browser; approve the sign-in with the Google
account you use for ZGAP. Only accounts the ZGAP administrator has approved can sign in.

The sign-in shows on the ZGAP console under Connect → OAuth as a `magpie` device. Log it out there to
revoke it. It is a session of its own: signing in here never logs out the [zgap CLI](https://github.com/kargnas/zgap)
on the same computer, and signing in here again updates the same session.

## How it works

- **Models**: read from ZGAP's `/v1/models` once you are signed in.
- **Requests**: ZGAP serves every model on Chat Completions, Messages and Responses, so magpie relays each
  agent's request in the protocol the agent sent it in. The plugin adds the current access token.
- **Tokens**: the access token lasts 24 hours. magpie renews it before it runs out with the refresh token,
  which ZGAP replaces on every renewal and keeps valid for 30 days.

## What ZGAP receives

Like the zgap CLI, each request carries diagnostic context for the ZGAP administrator: the plugin version,
the hostname and OS, the agent's working directory and project name, and the session ID magpie reports.
ZGAP stores it with the request's usage for up to 90 days and removes it before contacting the model
provider. It never includes prompts or command lines.

## Limits

magpie sends a plugin's requests with its own User-Agent and without the agent's own headers, such as
Claude Code's `X-App`.

## Development

```sh
node --test
```

To try a change without touching your own magpie, run it with a sandbox home:

```sh
env -i PATH="$PATH" HOME="$PWD/.sandbox" XDG_CONFIG_HOME="$PWD/.sandbox/.config" XDG_CACHE_HOME="$PWD/.sandbox/.cache" \
  /Applications/magpie.app/Contents/MacOS/magpie plugin add "$PWD"
```

## License

GPL-3.0
