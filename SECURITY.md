# Security policy

xPanel manages servers with root privileges, so security reports are taken seriously and handled privately.

## Reporting a vulnerability

Please **do not** open a public issue, discussion or pull request for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include:

- the affected component (for example `packages/render`, the API or the agent) and version or commit,
- the impact and a minimal way to reproduce it,
- any suggested fix, if you have one.

You will get an acknowledgement within 3 working days and a first assessment within 10 working days. Fixes are developed privately and released with an advisory; reporters are credited unless they ask not to be.

## Supported versions

xPanel is prelaunch and has no released versions yet. Reports against the latest commit on `main` are in scope.

## Scope

In scope: privilege escalation, isolation breaks between accounts, authentication or authorization bypass, injection into rendered configuration, SQL or shell, path traversal, and secrets exposure.

Out of scope: vulnerabilities in third-party services xPanel configures (report those upstream), denial of service by an authenticated root user, and issues that require an already-compromised host.
