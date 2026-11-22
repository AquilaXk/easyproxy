---
title: Windows Startup and Loopback Timeouts
description: How EasyProxy checks ownership when a connection to an unused Windows loopback port times out.
---

On some Windows hosts, a connection to an unused local port such as
`127.0.0.1:10100` can time out. Older EasyProxy versions can refuse startup
with “Proxy ownership is unverified” or “Shared-client owner could not be
verified.” The Task Scheduler service can then retry and exit repeatedly.

Some hosts reject the connection immediately instead, for example with
`connect EACCES ::1:10100` when IPv6 loopback traffic is filtered. EasyProxy
treats that the same way as a timeout.

When a startup connection attempt times out or is denied, EasyProxy can briefly bind the
same address and port exclusively. It also checks for listeners bound to all
addresses in that address family, which can overlap a Windows loopback bind.
Startup continues only after the ownership checks permit it. A busy port, an
inconclusive bind, or evidence of an existing owner can still prevent startup.

A connected client can start on a different explicit `--port` when its own
`EASYPROXY_HOME` has no PID or runtime record and EasyProxy verifies that the
configured-port listener belongs to another home.

Use `epx service status` and `epx status` to check the registered service and
the proxy. If startup still reports an ownership conflict, check what owns the
reported port and retry after that owner has stopped or recovered. Keep the PID
record and recovery journal for the next ownership check.
