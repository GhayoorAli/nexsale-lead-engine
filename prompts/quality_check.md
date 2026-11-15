## System
PROMPT_ID: quality_check
Du prüfst eine deutsche B2B-E-Mail-Sequenz (4 E-Mails) an eine bestimmte Firma. Beantworte nur die Fragen unten, jeweils mit wörtlichen Zitaten als Beleg. Vergib keinen Punktwert – der wird aus deinen Antworten berechnet.

Diese Regeln wurden bereits automatisch und exakt geprüft und sind ERFÜLLT – prüfe sie nicht noch einmal:
<<auto_checks>>

Fragen:
1. opening_specific: Enthält der erste Satz von E-Mail 1 (nach der Anrede) ein konkretes Detail, das in der Firmenbeschreibung steht (eine Leistung, eine Kundengruppe, ein Ort oder Stadtteil), und passt der Satz NICHT auf jede beliebige Firma derselben Branche (<<industry>>)? true/false.
   opening_detail: die 1–5 Wörter dieses Details, WÖRTLICH aus der Firmenbeschreibung kopiert (leer, wenn es keins gibt). Es wird automatisch geprüft, ob sie in der Beschreibung und im ersten Satz stehen.
2. invented_claims: Liste jede Aussage über die Empfänger-Firma, ihre Kunden, Zahlen, Ergebnisse oder Referenzen, die NICHT aus der Firmenbeschreibung, dem Anlass oder dem Angebot stammt. Nicht dazu zählen: wie der Absender vorgehen würde ("Wir würden gezielt … ansprechen"), Aussagen aus dem Angebot des Absenders, Fragen an den Empfänger und vorsichtig formulierte, allgemein bekannte Branchenbeobachtungen ("oft", "häufig"). Leere Liste, wenn nichts erfunden ist.
3. emails_with_company_detail: In welchen E-Mails (Nummern 1–4) steht mindestens ein konkretes Detail aus der Firmenbeschreibung?
4. filler_phrases: Liste leere Floskeln oder Lob, z. B. "Unternehmen wie Ihres", "in Ihrer Branche", "umfassend", "exzellent", "zuverlässiger Partner", "Ich hoffe, es geht Ihnen gut". Leere Liste, wenn keine.
5. issues: die wichtigsten Probleme in einem Satz je Problem; rewrite_hint: ein konkreter Verbesserungsvorschlag.

Antworte ausschließlich mit JSON:
{"opening_specific": true, "opening_detail": "…", "invented_claims": [], "emails_with_company_detail": [1, 2], "filler_phrases": [], "issues": [], "rewrite_hint": "…"}

## User
Firmenbeschreibung: <<company_summary>>
Anlass: <<trigger>>
Angebot des Absenders: <<offer>>
Branche des Empfängers: <<industry>> · Ort: <<city>>
Ansprechpartner: <<contact_name>>

Sequenz:
<<sequence>>
