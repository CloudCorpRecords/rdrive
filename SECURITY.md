# Security policy

rdrive guards people's personal files, so security reports are very welcome.

## Reporting a vulnerability

**Please don't open a public issue.** Instead, use GitHub's private reporting:
[Report a vulnerability](https://github.com/CloudCorpRecords/rdrive/security/advisories/new).

Include what you found, the steps to reproduce it, and what an attacker could do with it. You should hear back within a week.
Once a fix is released, you'll be credited in the advisory unless you'd rather not be.

## Supported versions

Only the latest release (and `main`) gets security fixes.

## In scope

- Getting into an account or files without valid credentials (including via GitHub sign-in)
- One user reading or changing another user's files or sessions
- Escaping a user's folder (path traversal)
- Cross-site scripting, CSRF, or session theft
- Anything that makes the server run attacker-supplied code

## Hardening tips for people running rdrive

- Don't expose rdrive directly to the internet by port-forwarding. Use Tailscale, a VPN or Cloudflare Tunnel.
- Use long, unique passwords, or GitHub sign-in with two-factor authentication turned on in GitHub.
- Check **Account → Signed-in devices** now and then, and sign out anything you don't recognise.
- Keep `data/` private and backed up. It holds your files, password hashes and the TLS private key.
