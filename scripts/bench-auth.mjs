process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "bench-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "bench-encryption-secret-with-at-least-32-chars";
process.env.RATE_LIMIT_MAX = "10000";
process.env.CHAT_RATE_LIMIT_MAX = "10000";
delete process.env.MONGODB_URI;

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_bench");

const { default: app } = await import("../src/index.js");
const { default: mongoose } = await import("mongoose");

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

async function post(path, body, cookie) {
  const started = performance.now();
  const response = await fetch(`${baseURL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body)
  });
  await response.arrayBuffer();
  return { ms: performance.now() - started, response };
}

function report(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p90 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)];
  const min = sorted[0];
  console.log(`${label.padEnd(28)} median ${median.toFixed(1).padStart(7)} ms   min ${min.toFixed(1).padStart(7)} ms   p90 ${p90.toFixed(1).padStart(7)} ms`);
}

const N = Number(process.env.BENCH_N || 7);
const password = "correct-horse-battery";

const warm = await post("/api/auth/signup", { name: "Warm Up", email: `warm-${Date.now()}@example.com`, password });
if (warm.response.status !== 201) throw new Error(`warmup signup failed: ${warm.response.status}`);

const signupSamples = [];
let lastCookie = null;
for (let i = 0; i < N; i += 1) {
  const email = `bench-${Date.now()}-${i}@example.com`;
  const result = await post("/api/auth/signup", { name: "Bench User", email, password });
  if (result.response.status !== 201) throw new Error(`signup failed: ${result.response.status}`);
  const setCookie = result.response.headers.getSetCookie().find(value => value.startsWith("vr_session="));
  lastCookie = setCookie ? setCookie.split(";")[0] : lastCookie;
  signupSamples.push(result.ms);
}
report("signup (bcrypt hash + db)", signupSamples);

const signinSamples = [];
const signinEmail = `bench-signin-${Date.now()}@example.com`;
await post("/api/auth/signup", { name: "Bench Signin", email: signinEmail, password });
for (let i = 0; i < N; i += 1) {
  const result = await post("/api/auth/signin", { email: signinEmail, password });
  if (result.response.status !== 200) throw new Error(`signin failed: ${result.response.status}`);
  signinSamples.push(result.ms);
}
report("signin (bcrypt compare + db)", signinSamples);

const meSamples = [];
for (let i = 0; i < N; i += 1) {
  const started = performance.now();
  const response = await fetch(`${baseURL}/api/auth/me`, { headers: { Cookie: lastCookie } });
  await response.arrayBuffer();
  meSamples.push(performance.now() - started);
  if (response.status !== 200) throw new Error(`me failed: ${response.status}`);
}
report("GET /auth/me (session)", meSamples);

await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
await mongoose.disconnect();
await mongod.stop();
