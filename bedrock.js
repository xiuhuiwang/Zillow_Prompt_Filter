// AWS SigV4 signing + Bedrock InvokeModel call, implemented with Web Crypto.
// Runs in the MV3 service worker (crypto.subtle and TextEncoder are available).
//
// This is the standard AWS Signature Version 4 algorithm:
//   https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
// Scoped for the "bedrock" service.

const enc = new TextEncoder();

function toHex(buf) {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return toHex(digest);
}

async function hmac(keyBytes, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return new Uint8Array(sig);
}

// AWS date strings: 20240101T120000Z and 20240101
function amzDates() {
  // Date.now is available in the service worker (this is not a Workflow script).
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return { amzDate: `${date}T${time}Z`, dateStamp: date };
}

async function signingKey(secretKey, dateStamp, region, service) {
  const kDate = await hmac(enc.encode("AWS4" + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

// Invoke a Bedrock model and return the parsed Anthropic-style message JSON.
export async function invokeBedrock(aws, modelId, body) {
  const { accessKeyId, secretAccessKey, sessionToken, region } = aws;
  const service = "bedrock";
  const host = `bedrock-runtime.${region}.amazonaws.com`;
  const canonicalUri = `/model/${encodeURIComponent(modelId)}/invoke`;
  const endpoint = `https://${host}${canonicalUri}`;
  const payload = JSON.stringify(body);

  const { amzDate, dateStamp } = amzDates();
  const payloadHash = await sha256Hex(payload);

  // Signed headers (alphabetical). content-type, host, x-amz-date are required;
  // x-amz-security-token is included only for temporary credentials.
  const headers = {
    "content-type": "application/json",
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders =
    signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    "POST",
    canonicalUri,
    "", // canonical query string (none)
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const key = await signingKey(secretAccessKey, dateStamp, region, service);
  const signature = toHex(await hmac(key, stringToSign));

  const authorization =
    `${algorithm} Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Amz-Date": amzDate,
      "X-Amz-Content-Sha256": payloadHash,
      Authorization: authorization,
      ...(sessionToken ? { "X-Amz-Security-Token": sessionToken } : {}),
      Accept: "application/json",
    },
    body: payload,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Bedrock ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}
