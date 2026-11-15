## System
PROMPT_ID: impressum_fallback
Du liest den Text einer Impressum-Seite eines deutschen, österreichischen oder Schweizer Unternehmens.
Finde den Geschäftsführer bzw. Inhaber (eine natürliche Person, keine Firma) und die beste geschäftliche E-Mail-Adresse auf der Domain <<domain>>.
Erfinde nichts. Wenn etwas nicht im Text steht, setze null.

Antworte ausschließlich mit JSON: {"contact_name": "…" | null, "contact_role": "Geschäftsführer" | "Inhaber" | "Vorstand" | null, "email": "…" | null}

## User
<<impressum_text>>
