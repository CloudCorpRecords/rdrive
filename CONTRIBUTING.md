# Contributing to rdrive

Thanks for helping! rdrive aims to stay **small, dependency-light and easy to audit**. It's software people
trust with their personal files, so simple code that's easy to review beats clever code.

## Getting started

```bash
git clone https://github.com/CloudCorpRecords/rdrive
cd rdrive
npm install
npm test
npm start
```

You need Node.js 22 or newer. The web app in `public/` is plain HTML/CSS/JS, with no build step: edit it and reload.

## Guidelines

- **Tests:** every change to auth, sessions, paths or file operations needs a test in `test/`.
- **Dependencies:** avoid adding new ones. If you think one is needed, open an issue first to discuss it.
- **Security first:** never put user-provided text into `innerHTML`, and never serve uploaded files inline
  unless their type is on the safe list in `server.js`. Every path from a client must go through `Files.resolve`.
- **Style:** match the surrounding code (2 spaces, single quotes, semicolons). Keep comments short and explain *why*.
- **Pull requests:** keep each one focused on a single change, and say how you tested it.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Please report them privately, not in public issues.
