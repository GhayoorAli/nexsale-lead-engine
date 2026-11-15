"""Mock of every external service used by the n8n workflows (MOCK_EXTERNAL=true).

Stdlib only. Start:  python tests/mock_server/server.py  (port 8787)

Services (path prefix -> what it imitates):
  /airtable/v0/...      Airtable REST + Meta API (in-memory base, formula subset)
  /google/v1/...        Google Places API (New) Text Search -> saved fixture
  /ai/openai/v1/...     OpenAI chat completions (deterministic answers per PROMPT_ID)
  /ai/anthropic/v1/...  Anthropic messages
  /slack/api/...        Slack Web API (chat.postMessage, chat.update)
  /slack/webhook        Slack incoming webhook (error handler)
  /slack/response       Slack response_url
  /gmail/v1/...         Gmail API (messages.send, profile) = the "test inbox"
  /hubspot/crm/...      HubSpot CRM v3/v4 objects, search, associations
  /dns/resolve          DNS-over-HTTPS (Google JSON API) for MX checks
  /web/<domain>/<path>  company websites (Impressum fixtures)
Control (tests only):
  POST /_control/reset, GET /_control/state, POST /_control/fail, POST /_control/ai_mode,
  POST /_control/seed
"""
import base64
import json
import os
import pathlib
import re
import sys
import threading
import time
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIX = ROOT / "fixtures"
sys.path.insert(0, str(ROOT.parent / "setup"))
from schema import LINKS, TABLES  # noqa: E402  – the same definitions setup/create_airtable_base.py creates

# field name -> Airtable type, per table (exactly what the real base has)
SCHEMA = {t: {f["name"]: f["type"] for f in fields} for t, fields in TABLES.items()}
for _t, _f, _target in LINKS:
    SCHEMA[_t][_f] = "multipleRecordLinks"
STRICT = os.environ.get("MOCK_STRICT_SCHEMA", "1") != "0"


class FieldError(Exception):
    def __init__(self, etype, message):
        super().__init__(message)
        self.etype, self.message = etype, message


def _is_iso_datetime(v):
    return isinstance(v, str) and re.match(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$", v) is not None


def validate_fields(tname, fields, typecast):
    """Reject what real Airtable rejects: unknown tables/fields and values of the wrong type."""
    if not STRICT:
        return
    if tname not in SCHEMA:
        raise FieldError("TABLE_NOT_FOUND", f'Could not find table {tname} in this base')
    cols = SCHEMA[tname]
    for k, v in (fields or {}).items():
        if k not in cols:
            if k in AUTONUMBER.values():
                raise FieldError("INVALID_VALUE_FOR_COLUMN", f'Field "{k}" is computed and cannot be written')
            raise FieldError("UNKNOWN_FIELD_NAME", f'Unknown field name: "{k}"')
        if v is None:
            continue
        t = cols[k]
        bad = False
        if t in ("singleLineText", "multilineText", "url", "phoneNumber"):
            bad = not isinstance(v, str) and not (typecast and isinstance(v, (int, float)) and not isinstance(v, bool))
        elif t == "email":
            bad = not isinstance(v, str) or (v != "" and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", v))
        elif t == "number":
            bad = isinstance(v, bool) or not (isinstance(v, (int, float)) or (typecast and isinstance(v, str) and re.match(r"^-?\d+(\.\d+)?$", v)))
        elif t == "checkbox":
            bad = not isinstance(v, bool)
        elif t == "dateTime":
            bad = not _is_iso_datetime(v)
        elif t == "singleSelect":
            bad = not isinstance(v, str)
        elif t == "multipleRecordLinks":
            bad = not isinstance(v, list) or not all(isinstance(x, str) and x.startswith("rec") for x in v)
        if bad:
            raise FieldError("INVALID_VALUE_FOR_COLUMN", f'Field "{k}" cannot accept the provided value ({type(v).__name__}: {str(v)[:60]})')
LOCK = threading.RLock()

AUTONUMBER = {"Clients": "client_id", "Campaigns": "campaign_id", "Leads": "lead_id", "Emails": "email_id",
              "Replies": "reply_id", "Meetings": "meeting_id", "Tasks": "task_id", "Logs": "log_id", "Blocklist": "block_id"}

DEFAULT_CLIENT = {
    "name": "Real Service GmbH", "industry": "Gebäudereinigung", "calendly_link": "https://calendly.com/nexsale-demo/15min",
    "sender_name": "Anna Berger", "sender_title": "Business Development", "sender_company": "Nexsale GmbH (Demo)",
    "sender_phone": "+49 30 0000000", "sender_website": "https://nexsale.example", "is_default": True,
    "qualifying_questions": "Wie groß ist die Fläche ungefähr, und wann endet Ihr aktueller Reinigungsvertrag?", "sender_company_footer": "Nexsale GmbH (Demo) · Beispielstraße 1, 10115 Berlin · Geschäftsführer: Max Beispiel · HRB 000000 B",
    "target_positive_replies": 20, "target_meetings": 4, "hubspot_owner_id": "", "slack_channel": "#leads",
}


def new_state():
    return {
        "airtable": {}, "autonum": {}, "meta_tables": [],
        "requests": [], "slack": [], "slack_webhook": [], "slack_responses": [], "gmail": [], "hubspot": {"contacts": {}, "companies": {}, "deals": {}, "notes": {}, "associations": []},
        "fail": {}, "ai_mode": {}, "ai_calls": [], "google_calls": [], "airtable_writes": [], "airtable_rejected": [], "calendly": [],
    }


STATE = new_state()


def rec_id():
    return "rec" + uuid.uuid4().hex[:14]


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


def table(name):
    return STATE["airtable"].setdefault(name, [])


def create_record(tname, fields):
    rid = rec_id()
    f = {k: v for k, v in (fields or {}).items() if v is not None}
    if tname in AUTONUMBER:
        n = STATE["autonum"].get(tname, 0) + 1
        STATE["autonum"][tname] = n
        f[AUTONUMBER[tname]] = n
    r = {"id": rid, "createdTime": now_iso(), "fields": f}
    table(tname).append(r)
    return r


def reset(seed_client=True):
    global STATE
    with LOCK:
        STATE = new_state()
        if seed_client:
            create_record("Clients", DEFAULT_CLIENT)


# ---------------------------------------------------------------- formula subset
TOKEN_RE = re.compile(r"\s*(?:(\{[^}]+\})|('(?:\\.|[^'])*'|\"(?:\\.|[^\"])*\")|(-?\d+(?:\.\d+)?)|(<=|>=|!=|=|<|>|&)|([A-Za-z_]+)\s*(?=\()|(\()|(\))|(,))")


def tokenize(s):
    pos, out = 0, []
    s = s.strip()
    while pos < len(s):
        m = TOKEN_RE.match(s, pos)
        if not m or m.end() == pos:
            raise ValueError("bad formula near: " + s[pos:pos + 20])
        pos = m.end()
        field, string, num, op, fn, lp, rp, comma = m.groups()
        if field:
            out.append(("field", field[1:-1]))
        elif string:
            out.append(("str", string[1:-1].replace("\\'", "'").replace('\\"', '"').replace("\\\\", "\\")))
        elif num:
            out.append(("num", float(num)))
        elif op:
            out.append(("op", op))
        elif fn:
            out.append(("fn", fn.upper()))
        elif lp:
            out.append(("(", None))
        elif rp:
            out.append((")", None))
        elif comma:
            out.append((",", None))
    return out


class Parser:
    def __init__(self, tokens):
        self.t, self.i = tokens, 0

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else (None, None)

    def take(self, kind=None):
        tok = self.peek()
        if kind and tok[0] != kind:
            raise ValueError("expected %s got %s" % (kind, tok))
        self.i += 1
        return tok

    def expr(self):
        left = self.atom()
        while self.peek()[0] == "op":
            op = self.take()[1]
            right = self.atom()
            left = ("bin", op, left, right)
        return left

    def atom(self):
        kind, val = self.peek()
        if kind == "fn":
            self.take()
            self.take("(")
            args = []
            if self.peek()[0] != ")":
                args.append(self.expr())
                while self.peek()[0] == ",":
                    self.take()
                    args.append(self.expr())
            self.take(")")
            return ("fn", val, args)
        if kind in ("field", "str", "num"):
            self.take()
            return (kind, val)
        if kind == "(":
            self.take()
            e = self.expr()
            self.take(")")
            return e
        raise ValueError("unexpected token %s" % (self.peek(),))


def norm_val(v):
    if isinstance(v, list):
        return ", ".join(str(x) for x in v)
    return v


def ev(node, fields):
    k = node[0]
    if k == "field":
        v = fields.get(node[1])
        return norm_val(v) if v is not None else ""
    if k in ("str", "num"):
        return node[1]
    if k == "bin":
        _, op, a, b = node
        x, y = ev(a, fields), ev(b, fields)
        if op == "&":
            return f"{x}{y}"
        if isinstance(x, bool) or isinstance(y, bool):
            x, y = bool(x), bool(y)
        elif isinstance(x, (int, float)) or isinstance(y, (int, float)):
            try:
                x, y = float(x or 0), float(y or 0)
            except (TypeError, ValueError):
                x, y = str(x), str(y)
        else:
            x, y = str(x), str(y)
        return {"=": x == y, "!=": x != y, "<": x < y, "<=": x <= y, ">": x > y, ">=": x >= y}[op]
    if k == "fn":
        _, name, args = node
        vals = [ev(a, fields) for a in args]
        if name == "AND":
            return all(bool(v) for v in vals)
        if name == "OR":
            return any(bool(v) for v in vals)
        if name == "NOT":
            return not bool(vals[0])
        if name == "TRUE":
            return True
        if name == "FALSE":
            return False
        if name == "BLANK":
            return ""
        if name == "LOWER":
            return str(vals[0]).lower()
        if name == "FIND":
            return str(vals[1]).find(str(vals[0])) + 1
        if name == "RECORD_ID":
            return fields.get("__id", "")
        if name == "ARRAYJOIN":
            return str(vals[0])
        raise ValueError("unsupported function " + name)
    raise ValueError("bad node")


def match_formula(formula, rec):
    if not formula:
        return True
    tree = Parser(tokenize(formula)).expr()
    f = dict(rec["fields"])
    f["__id"] = rec["id"]
    return bool(ev(tree, f))


# ---------------------------------------------------------------- AI mock
REPLY_FIXTURES = {}


def load_reply_fixtures():
    for p in (FIX / "replies").glob("*.json"):
        d = json.loads(p.read_text(encoding="utf-8"))
        REPLY_FIXTURES[d["body"].strip()[:60]] = d


CONFIDENCE = {"interested_01": 0.93, "interested_02": 0.8, "tricky_english": 0.88, "unclear_01": 0.45}


def field_from(text, label):
    m = re.search(r"^" + re.escape(label) + r":\s*(.*)$", text, re.M)
    return m.group(1).strip() if m else ""


def ai_answer(prompt_id, system, user):
    mode = STATE["ai_mode"].get(prompt_id) or STATE["ai_mode"].get("*")
    if mode and mode.get("count", 0) != 0:
        mode["count"] -= 1
        if mode["mode"] == "broken_json":
            return "Hier ist Ihre Sequenz: {emails: [kaputt"
        if mode["mode"] == "low_quality" and prompt_id == "quality_check":
            return json.dumps({"opening_specific": False, "opening_quote": "Guten Tag", "invented_claims": ["seit 20 Jahren"], "emails_with_company_detail": [1],
                               "filler_phrases": ["umfassend"], "issues": ["Erste Zeile ist generisch"], "rewrite_hint": "Konkreter einsteigen"})
        if mode["mode"] == "escaped_newlines" and prompt_id == "email_sequence":
            return json.dumps({"emails": [{"step": i, "subject": f"Betreff {i}", "body": "Guten Tag,\\n\\nkurzer Text zu Ihrer Büroreinigung in Berlin. Passt ein Telefonat?\\n\\nViele Grüße\\nAnna Berger"} for i in (1, 2, 3, 4)]})
    if prompt_id == "email_sequence":
        company = field_from(user, "Empfänger-Firma") or "Ihr Unternehmen"
        contact = field_from(user, "Ansprechpartner").split(" (")[0].strip()
        city = field_from(user, "Ort") or "Berlin"
        sender = field_from(user, "Absender").split(" von ")[0].split(",")[0] or "Anna Berger"
        last = contact.split()[-1] if contact and contact.lower() not in ("unbekannt", "null", "") else ""
        greet = f"Guten Tag {('Herr' if not last.endswith('a') else 'Frau')} {last}," if last else "Guten Tag,"
        emails = [
            {"step": 1, "subject": f"Unterhaltsreinigung bei {company.split()[0][:25]}", "subject_alt": f"Neue Büro-Kunden in {city}?",
             "body": f"{greet}\n\nauf Ihrer Website habe ich gesehen, dass {company} Büros und Arztpraxen in {city} betreut. Wir helfen Reinigungsfirmen, planbar neue Gewerbekunden zu gewinnen, ohne Kaltakquise am Telefon.\n\nHätten Sie nächste Woche 15 Minuten für ein kurzes Gespräch?\n\nViele Grüße\n{sender}"},
            {"step": 2, "subject": "Aufträge ohne Ausschreibungsstress", "body": f"{greet}\n\nviele Reinigungsfirmen hängen an wenigen Großkunden. Fällt einer weg, fehlt sofort Umsatz. Wir sorgen dafür, dass regelmäßig neue Anfragen von passenden Firmen kommen.\n\nWäre ein kurzes Telefonat dazu interessant?\n\nViele Grüße\n{sender}"},
            {"step": 3, "subject": "Ein Beispiel aus der Praxis", "body": f"{greet}\n\nso läuft es konkret: Wir suchen Hausverwaltungen und Praxen in {city}, schreiben sie persönlich an und geben nur echte Interessenten an Sie weiter. Sie führen dann nur noch das Erstgespräch.\n\nPasst ein Telefonat von 15 Minuten?\n\nViele Grüße\n{sender}"},
            {"step": 4, "subject": "Soll ich das Thema schließen?", "body": f"{greet}\n\nich möchte nicht aufdringlich sein und melde mich daher zum letzten Mal. Falls neue Gewerbekunden später ein Thema werden, antworten Sie einfach auf diese E-Mail.\n\nDarf ich mich in ein paar Monaten noch einmal melden?\n\nViele Grüße\n{sender}"},
        ]
        return json.dumps({"emails": emails}, ensure_ascii=False)
    if prompt_id == "quality_check":
        # like a well-behaved model: quote a real word that is in the description AND in email 1's opening
        summary = field_from(user, "Firmenbeschreibung").lower()
        m = re.search(r"E-Mail 1\n(?:Betreff:[^\n]*\n)?(?:(?:Guten Tag|Sehr geehrte)[^\n]*,\n+)?([^\n]+)", user)
        opening = (m.group(1) if m else "").lower()
        generic = {"berlin", "reinigung", "unternehmen", "firma", "kunden", "leistungen"}
        detail = next((w for w in re.findall(r"[a-zäöüß]{5,}", opening) if w in summary and w not in generic), "")
        return json.dumps({"opening_specific": bool(detail), "opening_detail": detail, "invented_claims": [], "emails_with_company_detail": [1, 3],
                           "filler_phrases": [], "issues": [], "rewrite_hint": ""})
    if prompt_id == "reply_classifier":
        body = user.split("Antwort:", 1)[-1].strip()
        fx = REPLY_FIXTURES.get(body[:60])
        if fx and fx.get("expected_category") not in (None, "Bounce"):
            cat = fx["expected_category"]
            conf = CONFIDENCE.get(fx["fixture"], 0.9)
            rd = None
            if fx["fixture"] == "later_01":
                rd = "2027-01-12"
            m = re.search(r"(20\d\d-\d\d-\d\d)", body)
            if cat == "Out of office" and m:
                rd = m.group(1)
            elif cat == "Out of office":
                rd = "2026-11-24"
            ref_name = ref_mail = ""
            if cat == "Referral":
                mn = re.search(r"(?:Frau|Herr)\s+((?:[A-ZÄÖÜ][a-zäöüß]+\s?){1,2})", body)
                me = re.search(r"([\w.\-]+@[\w.\-]+\.[a-z]+)", body)
                ref_name, ref_mail = (mn.group(1).strip() if mn else ""), (me.group(1) if me else "")
            return json.dumps({"category": cat, "confidence": conf, "return_date": rd, "summary": f"Antwort eingestuft als {cat}.",
                               "referral_name": ref_name, "referral_email": ref_mail}, ensure_ascii=False)
        low = body.lower()
        if re.search(r"interess|termin|zeit|call|gespräch", low):
            return json.dumps({"category": "Interested", "confidence": 0.9, "return_date": None, "summary": "Möchte ein Gespräch."})
        if re.search(r"kein interesse|kein bedarf|nein danke", low):
            return json.dumps({"category": "Not interested", "confidence": 0.9, "return_date": None, "summary": "Kein Interesse."})
        return json.dumps({"category": "Unclear", "confidence": 0.4, "return_date": None, "summary": "Unklar."})
    if prompt_id == "company_summary":
        company = field_from(user, "Firma").split(" (")[0]
        # like a careful model: people named on the team page ("Rolle: [Herr|Frau] Vorname Nachname[, email]") and one trigger
        team = user.split("Text der Team-/Kontaktseite:", 1)[-1].split("Text der Karriereseite:", 1)[0]
        jobs = user.split("Text der Karriereseite:", 1)[-1]
        contacts = []
        for m in re.finditer(r"([A-ZÄÖÜ][\wäöüß\- ]{2,30}):\s*(Herr|Frau)?\s*([A-ZÄÖÜ][a-zäöüß]+ [A-ZÄÖÜ][a-zäöüß]+)(?:,\s*([\w.\-]+@[\w.\-]+))?", team):
            contacts.append({"name": m.group(3), "role": m.group(1).strip(), "email": m.group(4) or "", "salutation": m.group(2) or ""})
        trig = re.search(r"(Wir suchen[^.]*\.)", jobs + " " + team)
        return json.dumps({"summary": f"{company} bietet Unterhaltsreinigung für Büros und Praxen, Glasreinigung und Treppenhausreinigung in Berlin an. Zu den Kunden zählen Hausverwaltungen, Arztpraxen und mittelständische Büros.",
                           "facts": [], "contacts": contacts, "trigger": trig.group(1) if trig else ""}, ensure_ascii=False)
    if prompt_id == "impressum_fallback":
        return json.dumps({"contact_name": None, "contact_role": None, "email": None})
    if prompt_id == "interested_reply":
        link = re.search(r"Buchungslink ein:\s*(\S+)", system)
        sender = re.search(r'"Viele Grüße" und (.+?)\.', system)
        return json.dumps({"body": f"Guten Tag,\n\nvielen Dank für Ihre schnelle Rückmeldung, das freut mich. Gerne zeige ich Ihnen in 15 Minuten, wie das bei Ihnen aussehen kann. Hier können Sie direkt einen passenden Termin wählen: {link.group(1) if link else ''}\n\nViele Grüße\n{sender.group(1) if sender else 'Anna Berger'}"}, ensure_ascii=False)
    if prompt_id == "meeting_brief":
        return json.dumps({"about": field_from(user, "Firmenbeschreibung")[:200] or "Reinigungsfirma.", "why_now": "Hat Interesse an einem Gespräch geäußert.",
                           "conversation": "Fragt nach einem Termin.", "questions_to_ask": ["Wer reinigt heute und wann endet der Vertrag?", "Wie groß sind die Objekte?"]}, ensure_ascii=False)
    if prompt_id == "referral_intro":
        ref = field_from(user, "Verwiesen von")
        return json.dumps({"subject": "Hinweis von Ihrem Kollegen", "body": f"{ref.split(' (')[0]} hat mich an Sie verwiesen. Wir übernehmen die regelmäßige Reinigung von Büros und Praxen mit festem Team.\n\nPasst Ihnen ein kurzes Telefonat von 15 Minuten?"}, ensure_ascii=False)
    if prompt_id == "inbound_lead_brief":
        name = field_from(user, "Name")
        company = field_from(user, "Firma")
        return json.dumps({"temperature": "hot", "brief": f"{name} leitet {company}, eine Gebäudereinigung mit 25–50 Mitarbeitenden.\nSucht 10 neue Termine pro Monat, Budget ca. 2.000 €, möchte sofort starten.\nErste Frage: Welche Kundengruppe soll zuerst angesprochen werden?"}, ensure_ascii=False)
    if prompt_id == "weekly_report":
        return json.dumps({"summary": "Diese Woche: Kampagne aktiv, E-Mails versendet und erste Antworten erhalten.\nGut: persönliche Einstiege mit Bezug auf die Website.\nSchwach: wenige Antworten auf Schritt 3.\nGarantie: positive Antworten und Termine siehe Tracker.\nNächste Woche: Betreff B testen."}, ensure_ascii=False)
    return json.dumps({"error": "unknown prompt"})


# ---------------------------------------------------------------- handler
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("MOCK_VERBOSE"):
            sys.stderr.write("mock: " + fmt % args + "\n")

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        return raw

    def _json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _text(self, code, text, ctype="text/html; charset=utf-8"):
        data = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PATCH(self):
        self.route("PATCH")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    def route(self, method):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)
        raw = self._body()
        try:
            body = json.loads(raw) if raw and raw[:1] in (b"{", b"[") else {}
        except ValueError:
            body = {}
        service = path.strip("/").split("/")[0]
        if service == "ai":
            service = "ai"
        with LOCK:
            if service != "_control":
                STATE["requests"].append({"t": now_iso(), "method": method, "service": service, "path": path})
                f = STATE["fail"].get(service)
                if f and f["count"] != 0:
                    f["count"] -= 1
                    return self._json(f["status"], {"error": {"type": "MOCK_FORCED_FAILURE", "message": f"forced {f['status']}"}})
            try:
                if service == "_control":
                    return self.control(method, path, body)
                if service == "airtable":
                    return self.airtable(method, path, query, body)
                if service == "google":
                    return self.google(method, path, body)
                if service == "ai":
                    return self.ai(path, body)
                if service == "slack":
                    return self.slack(path, body, raw)
                if service == "gmail":
                    return self.gmail(method, path, body)
                if service == "hubspot":
                    return self.hubspot(method, path, body)
                if service == "calendly":
                    return self.calendly(method, path, query, body)
                if service == "dns":
                    return self.dns(query)
                if service == "web":
                    return self.web(path)
            except Exception as e:  # noqa: BLE001 – mock must report, not die
                return self._json(500, {"error": {"type": "MOCK_ERROR", "message": repr(e)}})
        return self._json(404, {"error": "unknown mock path " + path})

    # ---- control
    def control(self, method, path, body):
        if path == "/_control/reset":
            reset(seed_client=body.get("seed_client", True))
            return self._json(200, {"ok": True})
        if path == "/_control/state":
            return self._json(200, STATE)
        if path == "/_control/fail":
            STATE["fail"][body["service"]] = {"status": int(body.get("status", 500)), "count": int(body.get("count", 1))}
            return self._json(200, {"ok": True})
        if path == "/_control/ai_mode":
            STATE["ai_mode"][body.get("prompt_id", "*")] = {"mode": body["mode"], "count": int(body.get("count", 1))}
            return self._json(200, {"ok": True})
        if path == "/_control/calendly":
            STATE["calendly"] = body.get("events", [])
            return self._json(200, {"ok": True})
        if path == "/_control/seed":
            out = []
            try:
                for r in body.get("records", []):
                    validate_fields(body["table"], r, True)
            except FieldError as fe:
                return self._json(422, {"error": {"type": fe.etype, "message": "seed: " + fe.message}})
            for r in body.get("records", []):
                out.append(create_record(body["table"], r))
            return self._json(200, {"records": out})
        return self._json(404, {"error": "unknown control"})

    # ---- airtable
    def airtable(self, method, path, query, body):
        parts = path.strip("/").split("/")  # airtable v0 <base> <table> [<id>]   or airtable v0 meta bases <base> tables ...
        if parts[2] == "meta":
            return self.airtable_meta(method, parts, body)
        tname = parts[3]
        rid = parts[4] if len(parts) > 4 else None
        if STRICT and tname not in SCHEMA:
            return self._json(404, {"error": {"type": "TABLE_NOT_FOUND", "message": f"Could not find table {tname}"}})
        recs = table(tname)
        if method == "GET" and rid:
            r = next((x for x in recs if x["id"] == rid), None)
            return self._json(200, r) if r else self._json(404, {"error": "NOT_FOUND"})
        if method == "GET":
            formula = (query.get("filterByFormula") or [""])[0]
            try:
                rows = [r for r in recs if match_formula(formula, r)]
            except ValueError as e:
                return self._json(422, {"error": {"type": "INVALID_FILTER_BY_FORMULA", "message": str(e)}})
            sort_field = (query.get("sort[0][field]") or [None])[0]
            if sort_field:
                desc = (query.get("sort[0][direction]") or ["asc"])[0] == "desc"
                rows.sort(key=lambda r: str(r["fields"].get(sort_field, "")), reverse=desc)
            maxr = int((query.get("maxRecords") or ["0"])[0] or 0)
            if maxr:
                rows = rows[:maxr]
            psize = int((query.get("pageSize") or ["100"])[0] or 100)
            offset = int((query.get("offset") or ["0"])[0] or 0)
            page = rows[offset:offset + psize]
            out = {"records": page}
            if offset + psize < len(rows):
                out["offset"] = str(offset + psize)
            return self._json(200, out)
        if method == "POST":
            records = body.get("records")
            if records is None:
                records = [{"fields": body.get("fields", {})}]
            if len(records) > 10:
                return self._json(422, {"error": {"type": "INVALID_REQUEST_UNKNOWN", "message": "max 10 records per request"}})
            try:
                for r in records:
                    validate_fields(tname, r.get("fields"), bool(body.get("typecast")))
            except FieldError as fe:
                STATE["airtable_rejected"].append({"table": tname, "method": "POST", "error": fe.message})
                return self._json(422, {"error": {"type": fe.etype, "message": fe.message}})
            STATE["airtable_writes"].append({"table": tname, "method": "POST", "records": [r.get("fields") for r in records]})
            created = [create_record(tname, r.get("fields")) for r in records]
            return self._json(200, {"records": created} if "records" in body else created[0])
        if method == "PATCH" and body.get("performUpsert"):
            # real Airtable upsert: match on fieldsToMergeOn, update the match or create a new record
            keys = body["performUpsert"].get("fieldsToMergeOn") or []
            records = body.get("records") or []
            if len(records) > 10 or not keys:
                return self._json(422, {"error": {"type": "INVALID_REQUEST_UNKNOWN", "message": "max 10 records / fieldsToMergeOn required"}})
            try:
                for r in records:
                    validate_fields(tname, r.get("fields"), bool(body.get("typecast")))
            except FieldError as fe:
                STATE["airtable_rejected"].append({"table": tname, "method": "UPSERT", "error": fe.message})
                return self._json(422, {"error": {"type": fe.etype, "message": fe.message}})
            STATE["airtable_writes"].append({"table": tname, "method": "POST", "upsert": True, "records": [r.get("fields") for r in records]})
            out, created_ids, updated_ids = [], [], []
            for r in records:
                f = r.get("fields") or {}
                hit = next((x for x in recs if all(x["fields"].get(k) == f.get(k) for k in keys)), None)
                if hit:
                    hit["fields"].update({k: v for k, v in f.items() if v not in (None, "")})
                    out.append(hit); updated_ids.append(hit["id"])
                else:
                    c = create_record(tname, f); out.append(c); created_ids.append(c["id"])
            return self._json(200, {"records": out, "createdRecords": created_ids, "updatedRecords": updated_ids})
        if method == "PATCH":
            records = body.get("records") or ([{"id": rid, "fields": body.get("fields", {})}] if rid else [])
            if len(records) > 10:
                return self._json(422, {"error": {"type": "INVALID_REQUEST_UNKNOWN", "message": "max 10 records per request"}})
            try:
                for u in records:
                    validate_fields(tname, u.get("fields"), bool(body.get("typecast")))
            except FieldError as fe:
                STATE["airtable_rejected"].append({"table": tname, "method": "PATCH", "error": fe.message})
                return self._json(422, {"error": {"type": fe.etype, "message": fe.message}})
            STATE["airtable_writes"].append({"table": tname, "method": "PATCH", "records": [u.get("fields") for u in records]})
            out = []
            for u in records:
                r = next((x for x in recs if x["id"] == u["id"]), None)
                if not r:
                    return self._json(404, {"error": {"type": "ROW_DOES_NOT_EXIST", "message": u["id"]}})
                for k, v in (u.get("fields") or {}).items():
                    if v is None or v == "":
                        r["fields"].pop(k, None)
                    else:
                        r["fields"][k] = v
                out.append(r)
            return self._json(200, {"records": out})
        if method == "DELETE":
            ids = query.get("records[]") or ([rid] if rid else [])
            if len(ids) > 10:
                return self._json(422, {"error": "max 10"})
            STATE["airtable"][tname] = [r for r in recs if r["id"] not in ids]
            return self._json(200, {"records": [{"id": i, "deleted": True} for i in ids]})
        return self._json(405, {"error": "method"})

    def airtable_meta(self, method, parts, body):
        # /airtable/v0/meta/bases/<base>/tables[/<tableId>/fields]
        tables = STATE["meta_tables"]
        if method == "GET":
            return self._json(200, {"tables": tables})
        if method == "POST" and len(parts) == 6:
            if any(t["name"] == body["name"] for t in tables):
                return self._json(422, {"error": {"type": "DUPLICATE_TABLE_NAME", "message": body["name"]}})
            t = {"id": "tbl" + uuid.uuid4().hex[:14], "name": body["name"], "fields": [dict(f, id="fld" + uuid.uuid4().hex[:14]) for f in body.get("fields", [])]}
            tables.append(t)
            return self._json(200, t)
        if method == "POST" and len(parts) == 8 and parts[7] == "fields":
            t = next((x for x in tables if x["id"] == parts[6]), None)
            if not t:
                return self._json(404, {"error": "table not found"})
            if any(f["name"] == body["name"] for f in t["fields"]):
                return self._json(422, {"error": {"type": "DUPLICATE_OR_EMPTY_FIELD_NAME"}})
            f = dict(body, id="fld" + uuid.uuid4().hex[:14])
            t["fields"].append(f)
            return self._json(200, f)
        return self._json(404, {"error": "meta path"})

    # ---- google
    def google(self, method, path, body):
        if not path.endswith("places:searchText"):
            return self._json(404, {"error": "unknown google path"})
        mask = self.headers.get("X-Goog-FieldMask", "")
        if not mask:
            return self._json(400, {"error": {"code": 400, "message": "FieldMask is a required parameter"}})
        if re.search(r"reviews|photos", mask):
            return self._json(400, {"error": {"message": "mock refuses expensive field mask"}})
        STATE["google_calls"].append({"body": body, "mask": mask, "key_present": bool(self.headers.get("X-Goog-Api-Key"))})
        data = json.loads((FIX / "google_places_berlin_10.json").read_text(encoding="utf-8"))
        size = min(20, int(body.get("pageSize") or 20))
        token = body.get("pageToken") or ""
        page = int(token[1:]) if token.startswith("p") and token[1:].isdigit() else 1
        query = str(body.get("textQuery", ""))
        # page 1 starts with the 10 saved companies; beyond that (and on pages 2-3) fictional fillers on .example,
        # like Google: max 20 per page, max 3 pages per search
        fixture = data["places"] if page == 1 and " in " in query and "," not in query else []
        tag = re.sub(r"[^a-z0-9]+", "-", query.lower()).strip("-")[-24:]
        filler = [{"id": f"mock-{tag}-p{page}-{i}", "displayName": {"text": f"Musterreinigung {tag} {page}-{i}", "languageCode": "de"},
                   "formattedAddress": f"Musterstraße {i}, 10115 Berlin", "nationalPhoneNumber": f"030 {page}{i:04d}",
                   "websiteUri": f"https://muster-{tag}-{page}-{i}.example/", "rating": 4.2, "userRatingCount": 12,
                   "types": ["point_of_interest"], "businessStatus": "OPERATIONAL", "googleMapsUri": "https://maps.google.com/?cid=1"} for i in range(size)]
        data["places"] = (fixture + filler)[:size]
        if page < 3:
            data["nextPageToken"] = f"p{page + 1}"
        else:
            data.pop("nextPageToken", None)
        return self._json(200, data)

    # ---- ai
    def ai(self, path, body):
        if path.endswith("/chat/completions"):
            msgs = body.get("messages", [])
            system = next((m["content"] for m in msgs if m["role"] == "system"), "")
            user = "\n".join(m["content"] for m in msgs if m["role"] == "user")
            pid = (re.search(r"PROMPT_ID:\s*(\w+)", system) or [None, "unknown"])[1]
            text = ai_answer(pid, system, user)
            STATE["ai_calls"].append({"prompt_id": pid, "provider": "openai", "user": user[:2000], "answer": text[:2000]})
            return self._json(200, {"id": "chatcmpl-mock", "object": "chat.completion", "model": body.get("model"),
                                    "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                                    "usage": {"prompt_tokens": 600, "completion_tokens": 350, "total_tokens": 950}})
        if path.endswith("/messages"):
            system = body.get("system", "")
            user = "\n".join(m["content"] if isinstance(m["content"], str) else "" for m in body.get("messages", []))
            pid = (re.search(r"PROMPT_ID:\s*(\w+)", system) or [None, "unknown"])[1]
            text = ai_answer(pid, system, user)
            STATE["ai_calls"].append({"prompt_id": pid, "provider": "anthropic", "user": user[:2000], "answer": text[:2000]})
            return self._json(200, {"id": "msg_mock", "type": "message", "role": "assistant", "content": [{"type": "text", "text": text}],
                                    "usage": {"input_tokens": 600, "output_tokens": 350}})
        return self._json(404, {"error": "unknown ai path"})

    # ---- slack
    def slack(self, path, body, raw):
        if path == "/slack/webhook":
            STATE["slack_webhook"].append(body or {"raw": raw.decode("utf-8", "replace")})
            return self._text(200, "ok", "text/plain")
        if path == "/slack/response":
            STATE["slack_responses"].append(body)
            return self._text(200, "ok", "text/plain")
        method = path.rsplit("/", 1)[-1]
        if method == "chat.postMessage":
            ts = "%.6f" % time.time()
            msg = {"ts": ts, "channel": body.get("channel", "#leads"), "text": body.get("text", ""), "blocks": body.get("blocks", []), "updates": []}
            STATE["slack"].append(msg)
            return self._json(200, {"ok": True, "channel": "C0LEADS", "ts": ts, "message": msg})
        if method == "chat.update":
            m = next((x for x in STATE["slack"] if x["ts"] == body.get("ts")), None)
            if m:
                m["updates"].append({"text": body.get("text"), "blocks": body.get("blocks")})
                m["text"], m["blocks"] = body.get("text", m["text"]), body.get("blocks", m["blocks"])
            return self._json(200, {"ok": bool(m), "ts": body.get("ts"), "error": None if m else "message_not_found"})
        if method == "auth.test":
            return self._json(200, {"ok": True, "user": "nexsale-bot"})
        return self._json(200, {"ok": False, "error": "unknown_method"})

    # ---- gmail
    def gmail(self, method, path, body):
        if path.endswith("/profile"):
            return self._json(200, {"emailAddress": "sender.test@nexsale-demo.test", "messagesTotal": len(STATE["gmail"])})
        if path.endswith("/messages/send"):
            raw = body.get("raw", "")
            pad = "=" * (-len(raw) % 4)
            decoded = base64.urlsafe_b64decode(raw + pad).decode("utf-8", "replace")
            head, _, enc_body = decoded.partition("\r\n\r\n")
            headers = {}
            for line in head.split("\r\n"):
                if ":" in line:
                    k, v = line.split(":", 1)
                    headers[k.strip().lower()] = v.strip()

            def dec_word(v):
                return re.sub(r"=\?UTF-8\?B\?([^?]+)\?=", lambda m: base64.b64decode(m.group(1)).decode("utf-8"), v or "")
            try:
                text = base64.b64decode(enc_body.replace("\r\n", "")).decode("utf-8")
            except Exception:  # noqa: BLE001
                text = enc_body
            mid = "msg" + uuid.uuid4().hex[:12]
            thread = body.get("threadId") or ("thr" + uuid.uuid4().hex[:12])
            m = {"id": mid, "threadId": thread, "to": headers.get("to", ""), "from": dec_word(headers.get("from", "")),
                 "subject": dec_word(headers.get("subject", "")), "body": text, "in_reply_to": headers.get("in-reply-to"), "sent_at": now_iso()}
            STATE["gmail"].append(m)
            return self._json(200, {"id": mid, "threadId": thread, "labelIds": ["SENT"]})
        return self._json(404, {"error": "gmail path"})

    # ---- hubspot
    def hubspot(self, method, path, body):
        hs = STATE["hubspot"]
        m = re.match(r"^/hubspot/crm/v3/objects/(\w+)(?:/(\w+))?(?:/(search))?$", path)
        if path.endswith("/search"):
            m2 = re.match(r"^/hubspot/crm/v3/objects/(\w+)/search$", path)
            otype = m2.group(1)
            flt = body["filterGroups"][0]["filters"][0]
            res = [o for o in hs[otype].values() if str(o["properties"].get(flt["propertyName"], "")).lower() == str(flt["value"]).lower()]
            return self._json(200, {"total": len(res), "results": res[:1]})
        if m and method == "POST" and not m.group(2):
            otype = m.group(1)
            oid = str(len(hs[otype]) + 1001)
            o = {"id": oid, "properties": body.get("properties", {}), "createdAt": now_iso()}
            hs[otype][oid] = o
            return self._json(201, o)
        if m and method == "PATCH" and m.group(2):
            o = hs[m.group(1)].get(m.group(2))
            if not o:
                return self._json(404, {"message": "not found"})
            o["properties"].update(body.get("properties", {}))
            return self._json(200, o)
        a = re.match(r"^/hubspot/crm/v4/objects/(\w+)/(\w+)/associations/default/(\w+)/(\w+)$", path)
        if a and method == "PUT":
            key = list(a.groups())
            if key not in hs["associations"]:
                hs["associations"].append(key)
            return self._json(200, {"status": "COMPLETE"})
        return self._json(404, {"message": "hubspot path " + path})

    # ---- calendly (free plan: polled API, no webhooks)
    def calendly(self, method, path, query, body):
        if path == "/calendly/users/me":
            return self._json(200, {"resource": {"uri": "https://api.calendly.com/users/MOCKUSER", "current_organization": "https://api.calendly.com/organizations/MOCKORG"}})
        if path == "/calendly/scheduled_events":
            return self._json(200, {"collection": [e["event"] for e in STATE["calendly"]], "pagination": {}})
        m = re.match(r"^/calendly/scheduled_events/([^/]+)/invitees$", path)
        if m:
            e = next((x for x in STATE["calendly"] if x["event"]["uri"].rsplit("/", 1)[-1] == m.group(1)), None)
            return self._json(200, {"collection": e["invitees"] if e else [], "pagination": {}})
        return self._json(404, {"message": "unknown calendly path"})

    # ---- dns
    def dns(self, query):
        name = (query.get("name") or [""])[0].lower().rstrip(".")
        web_map = json.loads((FIX / "web_map.json").read_text())
        known = name in web_map or name.endswith("nexsale-demo.test") or name == "keller-objektservice.example"
        if known:
            return self._json(200, {"Status": 0, "Answer": [{"name": name + ".", "type": 15, "TTL": 300, "data": f"10 mx.{name}."}]})
        return self._json(200, {"Status": 3, "Answer": []})

    # ---- web
    def web(self, path):
        parts = path.split("/", 3)  # '', 'web', domain, rest
        domain = parts[2] if len(parts) > 2 else ""
        rest = "/" + (parts[3] if len(parts) > 3 else "")
        web_map = json.loads((FIX / "web_map.json").read_text())
        entry = web_map.get(domain)
        if not entry:
            return self._text(404, "<h1>404</h1>")
        key = rest if rest in entry else rest.rstrip("/") if rest.rstrip("/") in entry else None
        if key is None and rest == "/":
            key = "/"
        if key is None or key not in entry:
            return self._text(404, "<html><body><h1>Seite nicht gefunden</h1></body></html>")
        return self._text(200, (FIX / entry[key]).read_text(encoding="utf-8"))


def main():
    port = int(os.environ.get("MOCK_PORT", "8787"))
    load_reply_fixtures()
    reset()
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"mock server on :{port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
