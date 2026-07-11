# Security Policy

X-GIS is a client-side rendering library — it compiles a style DSL to WebGPU
shaders and draws map data in the browser. The realistic security surface is
therefore about **untrusted input**, not a server: malformed vector tiles,
hostile GeoJSON, or a crafted style expression should fail safely, never execute
outside the sandbox or hang the tab.

## Reporting a vulnerability

Please **do not** open a public issue for a security report.

Use GitHub's private vulnerability reporting: go to the repository's **Security**
tab → **Report a vulnerability**. That opens a private advisory visible only to
the maintainers.

Include, where you can:

- affected version / commit,
- a minimal reproduction (a style snippet, a tile/GeoJSON fixture, or a repro
  URL),
- observed vs. expected behavior, and the impact you see.

## Scope

In scope: input-handling defects (parser/decoder crashes or hangs on malformed
tiles/GeoJSON, style-expression evaluation escaping its intended bounds),
prototype-pollution or ReDoS in the compiler, and anything that lets input read
or write outside the intended render pipeline.

Out of scope: issues that require a WebGPU driver bug to trigger, denial of
service that needs already-privileged access, and general rendering-correctness
bugs — those are ordinary [issues](.github/ISSUE_TEMPLATE/bug_report.md).
