// Preloaded into the server spawned by serve-proxy.test.ts.
//
// The proxy-verification check asks which uid owns the connecting socket,
// because that is the one thing about a loopback connection a non-root process
// cannot forge (measured: through a real `tailscale serve` the socket is uid 0;
// the identical headers sent straight at the port came off uid 1000). A test
// proxy runs as whoever runs the tests and never as root, so without this the
// end-to-end proof could only run on a machine with Tailscale set up — i.e.
// never in CI, on exactly the code that must not regress.
//
// This says "for this process, the test runner's uid is the proxy's uid". It
// widens nothing at runtime: it is only reachable from inside the process, via
// a --preload flag, and anything that can choose the server's command line
// already owns the server.
import { __trustProxyUid } from "../../src/remote.ts";

__trustProxyUid(process.getuid?.() ?? 0);
