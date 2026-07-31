# Security policy

## Reporting

Report privately through
[GitHub Security Advisories](https://github.com/parseen254/daraja-mcp/security/advisories/new),
or by email to hello@parseen.dev.

Please do not open a public issue for a security problem. This library sits in
front of a payments API, so a disclosed weakness is directly exploitable
against anyone running it.

Expect an acknowledgement within a few days. This is a personal project rather
than a funded one, so a fix may take longer than that, and I would rather say
so than promise a window I cannot hold.

## What matters most here

**Callback forgery.** Daraja callbacks are unsigned HTTP POSTs that change
payment state. The only thing separating a genuine result from a forged one is
the source address. Anything that lets an unverified callback be stored, or
that lets source verification be bypassed or silently disabled, is the highest
severity class in this project.

**Credential exposure.** Consumer secrets, passkeys, and security credentials
must never appear in tool output, logs, or error messages. `server_health`
reports whether a credential is configured, never its value. A path that leaks
one is a real vulnerability.

**Confused deputy through tool descriptions.** This is an MCP server, so its
tool descriptions are read by a model deciding what to call. A description that
could mislead a model into moving money it should not is a security concern,
not just a documentation bug.

Also in scope: anything letting an unauthenticated caller reach the callback
receiver's stored data, and dependency vulnerabilities that reach the published
package.

## What is out of scope

Vulnerabilities in Daraja itself. Report those to Safaricom at
apisupport@safaricom.co.ke.

Findings in devDependencies that cannot reach the published package. The
published tarball contains only `dist`, `README.md`, and `LICENSE`, so the test
and build toolchain does not ship to users. Worth reporting if you can show a
path to the built artifact.

Anything requiring an attacker to already control the machine running the
server.

## Deployment notes

Two controls exist and both are on by default in production:

**Source verification** checks inbound callbacks against Safaricom's published
egress ranges. The server refuses to start in production with
`DARAJA_CALLBACK_ALLOW_ANY_IP` set.

**Path secret** puts an unguessable segment in the callback URL, compared in
constant time. Set `DARAJA_CALLBACK_PATH_SECRET` to a random value in
production.

If you terminate TLS yourself with no proxy in front, be aware that
`X-Forwarded-For` is attacker-controlled and must not be trusted. See
[docs/going-live.md](docs/going-live.md).

## Supported versions

The latest published version on npm. Given the project's age there is no long
term support branch yet.
