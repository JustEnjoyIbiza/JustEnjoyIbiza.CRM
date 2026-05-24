// Netlify Function: Daily reminders for the day before a charter.
// Runs on a schedule (set in netlify.toml) and is also callable manually.
//
// Two channels:
//   1) CallMeBot — sends a SELF-digest to the captain's WhatsApp (free, simple).
//   2) Twilio    — sends a personalized message to each CLIENT (paid, ~€0.005/msg).
//
// Env vars (set in Netlify → Site settings → Environment variables):
//   SUPABASE_URL              (already used by the client)
//   SUPABASE_KEY              (already used by the client; anon key OK)
//
//   --- Self-digest (CallMeBot) ---
//   CALLMEBOT_PHONE           e.g. +34642453952  (number that registered with the bot)
//   CALLMEBOT_APIKEY          e.g. 1234567 (sent to you by CallMeBot on setup)
//
//   --- Client reminders (Twilio) ---
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_WHATSAPP_FROM      e.g. whatsapp:+14155238886 (sandbox) or your approved number
//   TWILIO_TEMPLATE_SID       Optional — Content SID of an approved template (for production).
//                             If absent, sends free-form text (works only for sandbox-joined numbers).
//
//   REMINDER_TRIGGER_KEY      Optional shared secret — when set, manual calls must include
//                             ?key=<value> in the URL. Scheduled invocations bypass this check.

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  // Decide whether this is a scheduled invocation or a manual one.
  // Netlify sets `event.headers["x-nf-event"]` / sends in via specific channel for scheduled runs,
  // but the simplest signal is: if body has params, treat as manual.
  let params = {};
  try { params = JSON.parse(event.body || "{}"); } catch (e) {}

  const isManual = event.httpMethod === "POST" || event.queryStringParameters;
  const isScheduled = !isManual; // scheduled functions arrive with no body

  // If TRIGGER_KEY is set, gate manual calls
  const TRIGGER_KEY = process.env.REMINDER_TRIGGER_KEY;
  if (isManual && TRIGGER_KEY) {
    const provided = (event.queryStringParameters && event.queryStringParameters.key) || params.key;
    if (provided !== TRIGGER_KEY) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "Bad or missing trigger key" }) };
    }
  }

  // Determine target date (default: tomorrow in Europe/Madrid time)
  const targetDate = params.date || madridTomorrowISO();
  const includeClients = params.includeClients !== false; // default true
  const includeSelf = params.includeSelf !== false;       // default true
  const dryRun = params.dryRun === true;

  try {
    const data = await fetchBookingsAndBoats(targetDate);
    const bookings = data.bookings;
    const boats = data.boats;

    if (bookings.length === 0) {
      // Still send a "no bookings tomorrow" digest so Alin knows the system ran
      const selfMsg = "📅 *Tomorrow — " + prettyDate(targetDate) + "*\n\nNo confirmed charters tomorrow. Enjoy the day off 🌅";
      let selfStatus = null;
      if (includeSelf && !dryRun) selfStatus = await sendSelf(selfMsg);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          date: targetDate,
          bookings: 0,
          dryRun,
          selfMessage: selfMsg,
          selfSent: selfStatus,
          clientResults: []
        })
      };
    }

    // ---- Build self-digest ----
    const selfMsg = buildSelfDigest(bookings, boats, targetDate);

    let selfStatus = null;
    if (includeSelf && !dryRun) selfStatus = await sendSelf(selfMsg);

    // ---- Build & send client messages ----
    const clientResults = [];
    if (includeClients) {
      for (const b of bookings) {
        const phone = normalizePhone(b.phone);
        if (!phone) {
          clientResults.push({ bookingId: b.id, name: b.name, skipped: "no valid phone" });
          continue;
        }
        const cmsg = buildClientMessage(b, boats);
        if (dryRun) {
          clientResults.push({ bookingId: b.id, name: b.name, phone, preview: cmsg, dryRun: true });
          continue;
        }
        const r = await sendClient(phone, cmsg, b, boats);
        clientResults.push({ bookingId: b.id, name: b.name, phone, sent: r.ok, error: r.error || null });
      }
    }

    const out = {
      date: targetDate,
      bookings: bookings.length,
      dryRun,
      selfMessage: selfMsg,
      selfSent: selfStatus,
      clientResults
    };
    if (isScheduled) console.log("Daily reminders run:", JSON.stringify(out));
    return { statusCode: 200, headers, body: JSON.stringify(out) };

  } catch (err) {
    console.error("Daily reminders failed:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || "Unknown error" }) };
  }
};

// ============================================================
// Supabase data fetch
// ============================================================
async function fetchBookingsAndBoats(targetDate) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Missing SUPABASE_URL / SUPABASE_KEY env vars");
  }
  const sbHeaders = {
    "apikey": SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY
  };

  // Pull ALL bookings (table is small) then filter client-side. The Supabase rows are
  // stored as {id, data:{...full object...}, updated_at}, so the date lives inside `data`.
  const bkResp = await fetch(SUPABASE_URL + "/rest/v1/bookings?select=*", { headers: sbHeaders });
  if (!bkResp.ok) throw new Error("Failed to fetch bookings: " + bkResp.status);
  const bkRows = await bkResp.json();
  const bookings = bkRows
    .map(r => r.data || r)
    .filter(b => b && b.date === targetDate && b.status === "confirmed")
    .sort((a, b) => (a.checkin || "").localeCompare(b.checkin || ""));

  const boatResp = await fetch(SUPABASE_URL + "/rest/v1/boats?select=*", { headers: sbHeaders });
  let boats = {};
  if (boatResp.ok) {
    const boatRows = await boatResp.json();
    boatRows.forEach(r => {
      const d = r.data || r;
      if (d && d.name) boats[d.name] = d;
    });
  }
  return { bookings, boats };
}

// ============================================================
// Message builders
// ============================================================
function buildSelfDigest(bookings, boats, targetDate) {
  const totalPax = bookings.reduce((s, b) => s + (Number(b.pax) || 0), 0);
  let msg = "🛥️ *Tomorrow — " + prettyDate(targetDate) + "*\n";
  msg += "*" + bookings.length + " charter" + (bookings.length === 1 ? "" : "s") + " · " + totalPax + " pax total*\n";
  bookings.forEach(b => {
    const t = b.checkin || "??:??";
    const boatInfo = boats[b.boat] || {};
    const marina = boatInfo.marina ? " (" + boatInfo.marina + (boatInfo.pier ? " p" + boatInfo.pier : "") + ")" : "";
    msg += "\n🕒 " + t + " — " + (b.name || "(no name)") + " (" + (b.pax || "?") + " pax)";
    msg += "\n⛵ " + (b.boat || "?") + marina;
    if (b.company) msg += "\n🏢 " + b.company;
    if (b.special) msg += "\n⚠ " + b.special;
    if (b.restaurant) msg += "\n🍽 " + b.restaurant;
    msg += "\n";
  });
  msg += "\n_Sent automatically by Just Enjoy CRM_";
  return msg;
}

function buildClientMessage(b, boats) {
  const t = b.checkin || "11:00";
  const boatInfo = boats[b.boat] || {};
  const dayLbl = prettyDate(b.date);
  const firstName = (b.name || "there").split(" ")[0];

  let msg = "Hi " + firstName + "! 👋\n\n";
  msg += "Just a friendly reminder — your charter with *Just Enjoy Ibiza* is *" + dayLbl + " at " + t + "*.\n\n";
  msg += "⛵ Boat: *" + (b.boat || "TBC") + "*\n";
  msg += "👥 Pax: *" + (b.pax || "?") + "*\n";
  if (boatInfo.marina) {
    msg += "📍 Marina: " + boatInfo.marina + (boatInfo.pier ? ", Pier " + boatInfo.pier : "") + "\n";
  }
  if (boatInfo.locationUrl) {
    msg += "🌍 " + boatInfo.locationUrl + "\n";
  }
  msg += "\nPlease be there *15 minutes early*. Bring swimwear, sun cream and good vibes 🌞\n\n";
  msg += "Any last-minute questions, just reply to this message.\n\n";
  msg += "— Alin, Just Enjoy Ibiza";
  return msg;
}

// ============================================================
// CallMeBot (self-digest)
// ============================================================
async function sendSelf(text) {
  const phone = process.env.CALLMEBOT_PHONE;
  const apiKey = process.env.CALLMEBOT_APIKEY;
  if (!phone || !apiKey) {
    return { ok: false, error: "CallMeBot not configured (missing CALLMEBOT_PHONE or CALLMEBOT_APIKEY)" };
  }
  const cleanPhone = phone.replace(/^\+/, "");
  const url =
    "https://api.callmebot.com/whatsapp.php" +
    "?phone=" + encodeURIComponent(cleanPhone) +
    "&apikey=" + encodeURIComponent(apiKey) +
    "&text=" + encodeURIComponent(text);

  try {
    const r = await fetch(url, { method: "GET" });
    const body = await r.text();
    if (!r.ok) return { ok: false, error: "CallMeBot HTTP " + r.status + ": " + body.substring(0, 200) };
    return { ok: true, response: body.substring(0, 200) };
  } catch (e) {
    return { ok: false, error: e.message || "CallMeBot network error" };
  }
}

// ============================================================
// Twilio (client reminders)
// ============================================================
async function sendClient(toPhone, freeFormText, booking, boats) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const templateSid = process.env.TWILIO_TEMPLATE_SID;

  if (!sid || !token || !from) {
    return { ok: false, error: "Twilio not configured" };
  }

  const body = new URLSearchParams();
  body.append("To", "whatsapp:" + toPhone);
  body.append("From", from.startsWith("whatsapp:") ? from : "whatsapp:" + from);

  if (templateSid) {
    // PRODUCTION mode — use approved template + variables
    const boatInfo = boats[booking.boat] || {};
    const firstName = (booking.name || "there").split(" ")[0];
    const dayLbl = prettyDate(booking.date);
    const checkin = booking.checkin || "11:00";
    const boatName = booking.boat || "your boat";
    const marina = boatInfo.marina
      ? (boatInfo.marina + (boatInfo.pier ? ", Pier " + boatInfo.pier : ""))
      : "the marina";
    const contentVars = {
      "1": firstName,
      "2": dayLbl,
      "3": checkin,
      "4": boatName,
      "5": String(booking.pax || "?"),
      "6": marina
    };
    body.append("ContentSid", templateSid);
    body.append("ContentVariables", JSON.stringify(contentVars));
  } else {
    // SANDBOX / dev mode — plain text (works only for numbers joined to the Twilio sandbox)
    body.append("Body", freeFormText);
  }

  const url = "https://api.twilio.com/2010-04-01/Accounts/" + sid + "/Messages.json";
  const auth = "Basic " + Buffer.from(sid + ":" + token).toString("base64");

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": auth,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });
    const json = await r.json();
    if (!r.ok) return { ok: false, error: "Twilio HTTP " + r.status + ": " + (json.message || JSON.stringify(json).substring(0, 200)) };
    return { ok: true, sid: json.sid };
  } catch (e) {
    return { ok: false, error: e.message || "Twilio network error" };
  }
}

// ============================================================
// Helpers
// ============================================================
function madridTomorrowISO() {
  // Compute "tomorrow" relative to Europe/Madrid time.
  // Madrid is UTC+1 in winter (CET) and UTC+2 in summer (CEST). Using a fixed +2h offset is
  // close enough for picking the right calendar date when running at 18:00 UTC (= 20:00 CEST / 19:00 CET).
  const now = new Date();
  const madrid = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const tomorrow = new Date(madrid);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return tomorrow.toISOString().split("T")[0];
}

function prettyDate(iso) {
  const d = new Date(iso + "T12:00:00");
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return days[d.getDay()] + " " + d.getDate() + " " + months[d.getMonth()];
}

function normalizePhone(raw) {
  if (!raw) return null;
  // Strip everything except digits and +
  let p = String(raw).replace(/[^\d+]/g, "");
  if (!p) return null;
  // If it doesn't start with +, assume Spanish number missing prefix
  if (!p.startsWith("+")) {
    // common case: leading 0
    p = p.replace(/^0+/, "");
    if (p.length === 9) p = "+34" + p; // Spanish mobile
    else p = "+" + p; // otherwise just stick a +
  }
  // Basic sanity — international numbers are 8–15 digits after the +
  const digits = p.replace(/\+/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return p;
}
