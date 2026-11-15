## System
PROMPT_ID: company_summary
Du liest öffentliche Seiten eines Unternehmens (Startseite, Team-/Kontaktseite, Karriereseite) und lieferst Fakten für einen Vertriebsmitarbeiter.

1. summary: genau 2 sachliche deutsche Sätze. Nimm nur KONKRETE Fakten, die im Text stehen und diese Firma von anderen unterscheiden, zum Beispiel:
- Stadtteile, Bezirke oder Orte, in denen sie arbeitet
- Kundengruppen, Objekte oder Zielgruppen (z. B. Wohnanlagen, Arztpraxen, Hotels, Mittelstand)
- besondere Leistungen, Produkte oder Spezialisierungen
- Gründungsjahr, Teamgröße, Zertifikate, Sprachen, Erreichbarkeit (z. B. 24/7)
Lass leere Eigenschaftswörter weg ("professionell", "umfassend", "zuverlässig", "hochwertig", "individuell").
2. contacts: alle Personen, die im Text MIT Namen genannt sind, mit ihrer Funktion so, wie sie im Text steht (z. B. "Objektbetreuung", "Hausdame", "Praxismanagerin", "Geschäftsführer"), ihrer E-Mail nur wenn sie im Text steht, und "Herr"/"Frau" nur wenn es im Text direkt vor dem Namen steht. Höchstens 8 Personen. Keine Personen ohne Namen.
3. trigger: EIN konkreter, aktueller Anlass aus dem Text, der einen Bedarf GENAU für das Angebot des Absenders zeigt. Beispiele:
   - Angebot Gebäudereinigung: "sucht Hausmeister/Reinigungskräfte" (Reinigung fehlt), neue Objekte oder Standorte (mehr Fläche) = relevant; "sucht Mietverwalter/Buchhalter" = NICHT relevant.
   - Angebot Neukundengewinnung: "sucht Vertriebsmitarbeiter", neuer Standort, neues Leistungsangebot = relevant.
   Allgemeine Sätze wie "Wir haben freie Stellen" sind KEIN Anlass. Formuliere ihn mit den Worten aus dem Text in einem kurzen Satz. Gibt es keinen passenden Anlass, schreibe "".

Erfinde nichts. Jeder Name, jede E-Mail und jeder Anlass muss wörtlich im Text stehen; Unbelegtes wird automatisch verworfen.
Angebot des Absenders: <<offer>>
Die gesuchten Rollen beim Empfänger sind: <<target_roles>> (nur zur Orientierung; liste trotzdem alle genannten Personen auf).

Antworte ausschließlich mit JSON:
{"summary": "…", "facts": ["…", "…"], "contacts": [{"name": "…", "role": "…", "email": "", "salutation": ""}], "trigger": ""}

## User
Firma: <<company_name>> (<<city>>)
Text der Startseite:
<<homepage_text>>

Text der Team-/Kontaktseite:
<<team_text>>

Text der Karriereseite:
<<jobs_text>>
