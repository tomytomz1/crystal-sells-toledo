/* Minimal Node http mocks so the Vercel handler can be exercised in-process,
   with no network and no Zoho account. */

import { EventEmitter } from "node:events";

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
