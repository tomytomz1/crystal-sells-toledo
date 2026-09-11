/* Minimal Node http mocks so the Vercel handler can be exercised in-process,
   with no network and no Zoho account. */

import { EventEmitter } from "node:events";
import { createServer, request } from "node:http";
import { createConnection } from "node:net";

export function mockReq({ method = "POST", body = {}, headers = {}, ip = "203.0.113.1" } = {}) {
  const req = new EventEmitter();
  req.method = method;
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  req.headers = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(raw)),
    "x-forwarded-for": ip,
    origin: "https://www.crystalsellstoledo.com",
    ...headers,
  };
  req.socket = { remoteAddress: ip };
  req.body = raw;
  req.destroy = () => {};
  return req;
}

export function mockRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(payload) { this.body = payload || ""; this.ended = true; },
  };
  res.json = () => { try { return JSON.parse(res.body); } catch { return null; } };
  return res;
}

/** Valid baseline payloads. */
export const validContact = {
  form_type: "contact",
  first_name: "Jane",
  last_name: "Doe",
  email: "jane@example.com",
  phone: "4195551234",
  topic: "Selling my home",
  message: "I would like to talk about selling.",
  page: "/contact",
  attribution: {
    utm_source: "google", utm_medium: "cpc", utm_campaign: "brand",
    gclid: "abc123", landing_page: "/?utm_source=google",
    referrer: "https://www.google.com/", first_touch_at: "2026-08-30T10:00:00.000Z",
  },
};

export const validHomeValue = {
  form_type: "home_value",
  first_name: "Sam",
  last_name: "Rivera",
  email: "sam@example.com",
  phone: "(419) 555-0000",
  property_address: "123 Louisiana Ave, Perrysburg, OH 43551",
  timeline: "Within 3 months",
  condition: "Well maintained, some updates",
  notes: "New roof in 2022.",
  page: "/home-value",
  attribution: {},
};

/* =====================================================================
   A REAL node:http BOUNDARY — for claims a mock cannot carry
   =====================================================================
   CLAUDE.md rule 14. An EventEmitter standing in for `req` has NO
   SOCKET, so nothing it does can show what happens to the `res` that
   shares one — which is exactly the class of defect #28 measured and
   #30 fixed on the live lead path. When the claim is "the client
   receives X", the test has to be a client.

   This harness OBSERVES. It never destroys the server's socket, because
   that socket is what carries the response under test.
   ===================================================================== */
export async function withHttpServer(handler, {
  method = "POST",
  path = "/api/lead",
  headers = {},
  /** Bytes written immediately. `null` writes nothing at all. */
  write = null,
  /** End the request body, or leave it open forever (the stall case). */
  end = false,
  /** Scheduled chunks: [msFromStart, data]. A real slow uplink, not a stall. */
  writes = null,
  /** Finish the body this many ms in. Without it a dripped body never ends. */
  endAt = null,
  /** A ceiling so a regression fails one assertion, not the whole run. */
  guardMs = 4000,
} = {}) {
  const seen = { server: {}, clientStatus: null, clientBody: "", clientError: null, ms: null };

  const server = createServer((req, res) => { handler(req, res, seen); });
  /* RECORDED, NEVER DESTROYED. Node's default clientError handler
     destroys the socket; copying that kills the very response under
     test and makes correct code look broken. */
  server.on("clientError", (err) => { seen.serverClientError = err.code; });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  let clientReq;
  const started = Date.now();
  try {
    await new Promise((resolve) => {
      let done = false;
      let guard;
      const pending = [];
      /* THE GUARD IS CLEARED ON THE WAY OUT. Left armed, it can fire
         during teardown and overwrite an ALREADY-RECEIVED status with
         NO_ANSWER — an observation that can be rewritten after the fact
         is not an observation. */
      const fin = () => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        for (const t of pending) clearTimeout(t);
        seen.ms = Date.now() - started;
        resolve();
      };

      clientReq = request({ host: "127.0.0.1", port, method, path, headers });
      clientReq.on("response", (res) => {
        seen.clientStatus = res.statusCode;
        res.on("data", (d) => { seen.clientBody += d; });
        res.on("end", fin);
      });
      clientReq.on("error", (err) => { seen.clientError = err.code || err.message; fin(); });

      /* HEADERS GO NOW, NOT WITH THE FIRST BYTE. Node buffers the request
         head until something writes or ends the body, so a case that
         deliberately sends NO body - the declared-length refusal, the
         pre-parsed fast path - would never reach the server at all and
         the test would report a missing response as a broken handler. */
      clientReq.flushHeaders();

      if (write !== null) clientReq.write(write);
      /* Timers here are cleared with the guard below, so a scheduled
         chunk can never fire into a request the test has finished with. */
      for (const [at, data] of writes || []) {
        pending.push(setTimeout(() => { try { clientReq.write(data); } catch { /* gone */ } }, at));
      }
      if (endAt !== null) {
        pending.push(setTimeout(() => { try { clientReq.end(); } catch { /* gone */ } }, endAt));
      }
      if (end) clientReq.end();

      guard = setTimeout(() => {
        seen.clientError = seen.clientError || "NO_ANSWER";
        fin();
      }, guardMs);
    });
  } finally {
    /* The CLIENT's half only. A stalled request's body never completes,
       so its connection lingers and server.close() alone never calls
       back — the test would hang rather than fail. Every observation is
       already recorded by this point. */
    try { clientReq?.destroy(); } catch { /* already gone */ }
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  return seen;
}

/* =====================================================================
   A RAW SOCKET — for claims about the CONNECTION, not just the response
   =====================================================================
   withHttpServer() above proves what the client receives. It cannot
   prove what state the server left the connection in, because its
   `finally` destroys the client socket and calls closeAllConnections()
   as soon as the response has been observed. That teardown is exactly
   what a connection-lifecycle assertion must not be measured through.

   So this one speaks HTTP/1.1 on a raw socket, observes for a fixed
   window with NOTHING torn down, and only then cleans up. It reports
   what was on the wire and what the SERVER did:

     * the status line and the Connection header it actually sent;
     * whether the response body arrived complete;
     * whether the SERVER closed the socket, and when;
     * how many requests the server dispatched on that one connection.

   `afterResponse` bytes are written once a response head has been seen,
   which is how a test asks "is this connection still usable?".
   ===================================================================== */
export async function withRawRequest(handler, {
  /** Complete raw request bytes, headers included. */
  request,
  /** Written once a response head has been seen. Null writes nothing. */
  afterResponse = null,
  /** How long to watch the connection before tearing anything down. */
  observeMs = 500,
} = {}) {
  const dispatched = [];
  const server = createServer((req, res) => {
    dispatched.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  server.on("clientError", () => { /* observe only, never destroy */ });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const sock = createConnection({ host: "127.0.0.1", port });
  let raw = "";
  let closedAt = null;
  let clientError = null;
  let wroteAfter = false;
  const t0 = Date.now();

  /* CLEANUP IS IN A `finally`, and it is not decoration. A listening
     server and a live socket left behind do not fail a test — they hang
     the whole run, which is a far worse failure than an assertion. This
     harness already cost one debugging round to a missing import that
     surfaced exactly that way. */
  try {
    await new Promise((resolve) => {
      sock.on("data", (d) => {
        raw += d;
        if (!wroteAfter && afterResponse !== null && raw.includes("\r\n\r\n")) {
          wroteAfter = true;
          try { sock.write(afterResponse); } catch { /* already closed */ }
        }
      });
      sock.on("close", () => { closedAt = Date.now() - t0; });
      sock.on("error", (err) => { clientError = err.code || err.message; });
      try { sock.write(request); } catch (err) { clientError = err.code || err.message; }
      setTimeout(resolve, observeMs);
    });
  } finally {
    /* AFTER the observation window, never before it: tearing the
       connection down is what this harness exists to avoid doing early. */
    sock.destroy();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }

  const head = raw.split("\r\n\r\n")[0] || "";
  const body = raw.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  return {
    raw,
    status: Number((head.match(/^HTTP\/1\.\d (\d+)/) || [])[1]) || null,
    connection: (head.match(/\r\nConnection: *(\S+)/i) || [])[1] || null,
    body,
    responseCount: (raw.match(/HTTP\/1\.\d \d\d\d/g) || []).length,
    serverClosed: closedAt !== null,
    closedAt,
    clientError,
    dispatched,
  };
}
