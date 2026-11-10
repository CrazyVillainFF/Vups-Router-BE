import { Router } from "express";
import { validTaskId } from "../task.js";
import { abortTask, kickTaskWorker } from "../taskWorker.js";
import { isServiceRequest, serviceAuthConfigured } from "../serviceRole.js";

/**
 * The only endpoints another VupsRouter service may call (Phase 3).
 *
 * They are mounted on the role that executes work, behind a shared secret, and they carry no user
 * authority at all: a session cookie is not accepted here and a service key buys nothing a user can
 * read. Both are deliberately advisory — one says "there may be something to claim", the other says
 * "a task you might be holding has been cancelled by its owner" — so the worst a forged call can do
 * is make this process look at its own queue a moment earlier, which any authenticated user can
 * already cause by submitting a task.
 *
 * That low blast radius is why neither route returns task contents. There is nothing here worth
 * probing, and nothing here that can be used to run work the database has not already queued.
 */

const router = Router();

function requireService(req, res, next) {
  if (!serviceAuthConfigured()) {
    // No secret configured means no peer is expected. Answering 401 would advertise the endpoint.
    return res.status(404).json({ code: "not_found", message: "That API route does not exist." });
  }
  // The `x-vups-service-key` header is compared as a hash digest in constant time.
  if (!isServiceRequest(req)) {
    return res.status(401).json({ code: "service_unauthorized", message: "Service credentials are required." });
  }
  return next();
}

function taskIdBody(req, res) {
  const taskId = typeof req.body?.taskId === "string" ? req.body.taskId.trim() : "";
  if (!validTaskId(taskId)) {
    res.status(400).json({ code: "invalid_task_id", message: "That task id is not one this server issues." });
    return null;
  }
  return taskId;
}

router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

router.post("/tasks/wake", requireService, async (req, res) => {
  const taskId = taskIdBody(req, res);
  if (!taskId) return undefined;
  // The id is echoed only as a shape check. Whether this task is real, still open and this
  // process's to run is decided by the lease compare-and-set, not by anything a caller asserts.
  const woke = await kickTaskWorker();
  return res.status(202).json({
    ok: true,
    code: woke ? "claim_pass_started" : "claim_pass_unavailable",
    taskId
  });
});

/**
 * Speed up a cancellation the record already carries.
 *
 * `held` says whether this process was running it, and a false answer is not a failure: the owner is
 * the row, and the holder's next lease renewal reads the same cancellation. This exists so the wait
 * is one request instead of one heartbeat interval.
 */
router.post("/tasks/cancel", requireService, async (req, res) => {
  const taskId = taskIdBody(req, res);
  if (!taskId) return undefined;
  const held = abortTask(taskId);
  return res.json({ ok: true, code: held ? "abort_signalled" : "not_held_here", taskId, held });
});

export default router;
