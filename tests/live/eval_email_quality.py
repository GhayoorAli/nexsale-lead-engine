"""Live evaluation of the AI email prompts on real lead inputs (costs ~€0.01 per run, nothing is sent).

For each input: write the sequence with prompts/email_sequence.md, check it with our rules (validateEmails.js via node),
then score it with prompts/quality_check.md – exactly like Module 4 (incl. one rewrite below 80).
Usage: python tests/live/eval_email_quality.py [--runs 1]
"""
import argparse
import json
from pathlib import Path
import pathlib
import re
import subprocess

import requests
from dotenv import dotenv_values

ROOT = pathlib.Path(__file__).resolve().parents[2]
E = dotenv_values(ROOT / ".env")


def prompt(pid, vars_):
    md = (ROOT / "prompts" / f"{pid}.md").read_text(encoding="utf-8")
    sys_, _, user = md.partition("## User")
    sys_ = sys_.replace("## System", "").strip()
    fill = lambda t: re.sub(r"<<\s*(\w+)\s*>>", lambda m: str(vars_.get(m.group(1), "")), t)  # noqa: E731
    return fill(sys_), fill(user.strip())


def ai(pid, vars_, temperature=None):
    s, u = prompt(pid, vars_)
    temperature = 0 if pid == "quality_check" else (0.4 if temperature is None else temperature)
    r = requests.post("https://api.openai.com/v1/chat/completions", timeout=90, headers={"Authorization": "Bearer " + E["OPENAI_API_KEY"]},
                      json={"model": E.get("AI_MODEL") or "gpt-4o-mini", "temperature": temperature, "max_tokens": 1600, "response_format": {"type": "json_object"},
                            "messages": [{"role": "system", "content": s}, {"role": "user", "content": u}]})
    r.raise_for_status()
    return json.loads(r.json()["choices"][0]["message"]["content"])


def prepare(seq, v):
    """the same deterministic clean-up 14_ai_call applies (greeting + sign-off guaranteed)"""
    js = "const VA=require('./code/validators');const VE=require('./code/validateEmails');const a=JSON.parse(process.argv[1]);console.log(JSON.stringify(VA.prepareByPrompt('email_sequence',a.d,a.o,VE)))"
    sig = subprocess.run(["node", "-e", "const V=require('./code/validateEmails');console.log(JSON.stringify(V.buildSignature(JSON.parse(process.argv[1]))))", json.dumps(CLIENT)],
                         cwd=ROOT, capture_output=True, text=True).stdout
    o = {"contactName": v.get("contact_name", ""), "contactSalutation": v.get("contact_salutation", ""), "senderName": CLIENT["sender_name"], "signature": json.loads(sig)}
    out = subprocess.run(["node", "-e", js, json.dumps({"d": seq, "o": o})], cwd=ROOT, capture_output=True, text=True).stdout
    return json.loads(out)


CLIENT = {"sender_name": "Anna Berger", "sender_title": "Business Development", "sender_company": "Nexsale GmbH"}
OFFER = subprocess.run(["node", "-e", "console.log(require('./code/validateEmails').offerText({}, 'Reinigungsunternehmen'))"], cwd=ROOT, capture_output=True, text=True).stdout.strip()


def with_sender(v):
    return dict(v, sender_name=CLIENT["sender_name"], sender_title=CLIENT["sender_title"], sender_company=CLIENT["sender_company"], offer=OFFER)


def rules(seq):
    js = "const V=require('./code/validateEmails');const s=V.normaliseSequence(JSON.parse(process.argv[1]));const r=V.validateSequence(s,{senderName:'Anna Berger'});console.log(JSON.stringify({ok:r.ok,errors:r.errors,words:s.map(e=>V.countWords(e.body))}))"
    return json.loads(subprocess.run(["node", "-e", js, json.dumps(seq)], cwd=ROOT, capture_output=True, text=True).stdout)


def seq_text(seq):
    return "\n\n".join(f"E-Mail {e['step']}\nBetreff: {e['subject']}\n{e['body']}" for e in seq["emails"])


def computed_score(q, ctx):
    js = "const V=require('./code/validators');const a=JSON.parse(process.argv[1]);console.log(V.qualityScore(a.q,a.ctx))"
    return int(subprocess.run(["node", "-e", js, json.dumps({"q": q, "ctx": ctx})], cwd=ROOT, capture_output=True, text=True).stdout.strip())


def quality(seq, v):
    q = _quality(seq, v)
    q["score"] = computed_score(q, {"summary": v["company_summary"], "sequence": seq_text(seq)})
    return q


def _quality(seq, v):
    words = ", ".join(f"E-Mail {e['step']}: {w}" for e, w in zip(seq["emails"], rules(seq)["words"]))
    return ai("quality_check", {"company_summary": v["company_summary"], "contact_name": v["contact_name"], "offer": OFFER,
                                "auto_checks": f"- Wortanzahl je E-Mail (max. 89): {words}\n- Durchgehend Sie-Form, keine Ausrufezeichen, keine Platzhalter",
                                "sequence": "\n\n".join(f"E-Mail {e['step']}\nBetreff: {e['subject']}\n{e['body']}" for e in seq["emails"])})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--inputs", default=str(ROOT / "tests/live/eval_inputs.json"))
    a = ap.parse_args()
    inputs = json.loads(Path(a.inputs).read_text())
    rows = []
    for _ in range(a.runs):
        for v in inputs:
            seq = prepare(ai("email_sequence", dict(with_sender(v), retry_note="")), v)
            r = rules(seq)
            invalid_first = not r["ok"]
            if not r["ok"]:  # like 14_ai_call: one retry that names the broken rules
                note = ("Deine letzte Antwort:\n" + json.dumps(seq, ensure_ascii=False) + "\n\nDiese Antwort war ungültig: " + "; ".join(r["errors"])
                        + ". Behalte alles andere bei und ändere nur die genannten Stellen.")
                seq = prepare(ai("email_sequence", dict(with_sender(v), retry_note=note)), v)
                r = rules(seq)
            q = quality(seq, v) if r["ok"] else {"score": 0, "issues": r["errors"]}
            final, rewritten = q["score"], False
            if r["ok"] and q["score"] < 80:
                hint = f"Die vorige Version erhielt nur {q['score']}/100. Probleme: {'; '.join(q.get('issues', []))}. Hinweis: {q.get('rewrite_hint', '')}. Schreibe die Sequenz neu und behebe diese Punkte."
                seq2 = prepare(ai("email_sequence", dict(with_sender(v), retry_note=hint)), v)
                r2 = rules(seq2)
                if r2["ok"]:
                    final, rewritten, seq = quality(seq2, v)["score"], True, seq2
            rows.append({"company": v["company_name"][:40], "rules_ok": r["ok"], "rules_retry": invalid_first, "first": q["score"], "final": final, "rewritten": rewritten,
                         "passed": final >= 80, "opening": seq["emails"][0]["body"].split(". ")[0][:160], "sequence": seq["emails"]})
            print(f"{rows[-1]['company']:40} rules={'ok' if r['ok'] else 'FAIL'}{'(retry)' if invalid_first else ''} first={q['score']:>3} final={final:>3} {'PASS' if final >= 80 else 'fail'}")
    n = len(rows)
    print(f"\npass rate: {sum(r['passed'] for r in rows)}/{n} | first-try pass: {sum(r['first'] >= 80 for r in rows)}/{n}")
    out = ROOT / "tests" / "results" / "email_quality_eval.json"
    out.write_text(json.dumps(rows, indent=2, ensure_ascii=False))
    for r in rows[:3]:
        print("  opening:", r["opening"])


if __name__ == "__main__":
    main()
