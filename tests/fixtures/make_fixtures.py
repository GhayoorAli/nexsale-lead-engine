"""Generates the synthetic fixtures in tests/fixtures/ (run once; output is committed).

The Google Places response mirrors the exact shape of places:searchText (New) with the
Module 2 field mask. Companies and domains are FICTIONAL (.example TLD, RFC 2606) so no
real company is ever referenced. Replace with a real capture via
setup/capture_places_fixture.py once GOOGLE_MAPS_API_KEY is set (see docs/blockers.md).
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).parent

COMPANIES = [
    # id, name, domain, phone, street, plz, rating, reviews, impressum fixture, homepage style
    ("ChIJ-demo-0001", "Glanzwerk Gebäudereinigung GmbH", "glanzwerk-berlin.example", "030 12345601", "Oranienstraße 12", "10999", 4.6, 87, "normal_01", "std"),
    ("ChIJ-demo-0002", "Spreeblick Reinigungsservice UG", "spreeblick-reinigung.example", "030 12345602", "Warschauer Straße 33", "10243", 4.3, 41, "normal_02", "std"),
    ("ChIJ-demo-0003", "Kiezsauber Facility Services GmbH", "kiezsauber.example", "030 12345603", "Karl-Marx-Straße 101", "12043", 4.8, 112, "hard_two_directors", "std"),
    ("ChIJ-demo-0004", "Blitzblank Büroreinigung e.K.", "blitzblank-buero.example", "030 12345604", "Schönhauser Allee 70", "10437", 4.1, 23, "normal_03", "std"),
    ("ChIJ-demo-0005", "Hauptstadt Glas- und Gebäudeservice GmbH", "hauptstadt-glas.example", "030 12345605", "Kurfürstendamm 200", "10719", 3.9, 15, "hard_at_email", "std"),
    ("ChIJ-demo-0006", "Reinraum Profis Berlin GmbH", "reinraum-profis.example", "030 12345606", "Alt-Moabit 90", "10559", 4.5, 64, "normal_04", "link"),
    ("ChIJ-demo-0007", "Frischwind Reinigung GbR", "frischwind-reinigung.example", "030 12345607", "Sonnenallee 150", "12059", 4.0, 9, "normal_05", "std"),
    ("ChIJ-demo-0008", "Sauberzauber Dienstleistungen GmbH", "sauberzauber.example", "030 12345608", "Frankfurter Allee 55", "10247", 4.7, 230, "normal_06", "std"),
    ("ChIJ-demo-0009", "Weißensee Clean Team", "weissensee-clean.example", "030 12345609", "Berliner Allee 120", "13088", 3.6, 7, "hard_no_impressum", "none"),
    ("ChIJ-demo-0010", "Charlottenburger Hausmeister- und Reinigungsdienst GmbH", "cb-hausdienst.example", "030 12345610", "Kantstraße 44", "10625", 4.2, 31, "generic_info_only", "std"),
]
# Places that must be skipped by mapPlaces.js (not part of the 10-lead response)
EXTRA_SKIPPED = [
    {"id": "ChIJ-demo-0011", "displayName": {"text": "Alte Reinigung (geschlossen)", "languageCode": "de"}, "formattedAddress": "Hermannstraße 1, 12049 Berlin, Deutschland",
     "businessStatus": "CLOSED_PERMANENTLY", "websiteUri": "https://alte-reinigung.example/", "types": ["point_of_interest"]},
    {"id": "ChIJ-demo-0012", "displayName": {"text": "Putzfee Mobil", "languageCode": "de"}, "formattedAddress": "Turmstraße 5, 10559 Berlin, Deutschland",
     "businessStatus": "OPERATIONAL", "nationalPhoneNumber": "0176 1234567", "types": ["point_of_interest"]},
]


def place(c):
    pid, name, domain, phone, street, plz, rating, reviews, _imp, _home = c
    return {
        "id": pid,
        "types": ["point_of_interest", "establishment"],
        "nationalPhoneNumber": phone,
        "formattedAddress": f"{street}, {plz} Berlin, Deutschland",
        "rating": rating,
        "googleMapsUri": f"https://maps.google.com/?cid={pid[-4:]}",
        "websiteUri": f"https://www.{domain}/" if pid.endswith(("1", "6")) else f"https://{domain}/kontakt?utm_source=gmb",
        "userRatingCount": reviews,
        "businessStatus": "OPERATIONAL",
        "displayName": {"text": name, "languageCode": "de"},
    }


IMPRESSUM = {
    "normal_01": ("Glanzwerk Gebäudereinigung GmbH", """
<h1>Impressum</h1><p>Angaben gemäß § 5 TMG</p>
<p>Glanzwerk Gebäudereinigung GmbH<br>Oranienstraße 12<br>10999 Berlin</p>
<h2>Vertreten durch</h2><p>Geschäftsführer: Thomas Becker</p>
<h2>Kontakt</h2><p>Telefon: 030 12345601<br>E-Mail: <a href="mailto:t.becker@glanzwerk-berlin.example">t.becker@glanzwerk-berlin.example</a></p>
<p>Weitere Anfragen: info@glanzwerk-berlin.example</p>
<h2>Registereintrag</h2><p>Eintragung im Handelsregister.<br>Registergericht: Amtsgericht Charlottenburg<br>Registernummer: HRB 201234 B</p>
<p>Datenschutz: datenschutz@glanzwerk-berlin.example</p>""",
        {"email": "t.becker@glanzwerk-berlin.example", "contact_name": "Thomas Becker", "contact_role": "Geschäftsführer", "register_number": "HRB 201234 B", "legal_form": "GmbH"}),
    "normal_02": ("Spreeblick Reinigungsservice UG (haftungsbeschränkt)", """
<div class="impressum"><h2>Impressum</h2>
<strong>Spreeblick Reinigungsservice UG (haftungsbeschränkt)</strong><br/>Warschauer Straße 33, 10243 Berlin<br/>
Geschäftsführerin: Aylin Yilmaz<br/>
Handelsregister: Amtsgericht Charlottenburg, HRB198765<br/>
USt-IdNr.: DE312345678<br/>
Kontakt: kontakt@spreeblick-reinigung.example · a.yilmaz@spreeblick-reinigung.example</div>""",
        {"email": "a.yilmaz@spreeblick-reinigung.example", "contact_name": "Aylin Yilmaz", "contact_role": "Geschäftsführer", "register_number": "HRB198765", "legal_form": "UG (haftungsbeschränkt)"}),
    "normal_03": ("Blitzblank Büroreinigung e.K.", """
<h1>Impressum</h1>
<p>Blitzblank Büroreinigung e.K.<br>Inh. Jan Hoffmann<br>Schönhauser Allee 70, 10437 Berlin</p>
<p>Inhaber: Jan Hoffmann</p>
<p>Tel. 030 12345604 &middot; Mail: jan.hoffmann@blitzblank-buero.example</p>
<p>Handelsregister: HRA 54321 B, Amtsgericht Charlottenburg</p>""",
        {"email": "jan.hoffmann@blitzblank-buero.example", "contact_name": "Jan Hoffmann", "contact_role": "Inhaber", "register_number": "HRA 54321 B", "legal_form": "e.K."}),
    "normal_04": ("Reinraum Profis Berlin GmbH", """
<section id="legal"><h3>Impressum &amp; Anbieterkennzeichnung</h3>
<p>Reinraum Profis Berlin GmbH, Alt-Moabit 90, 10559 Berlin</p>
<p>Vertretungsberechtigter Geschäftsführer: Dr. Stefan Neumann</p>
<p>Registergericht Berlin-Charlottenburg HRB 165432</p>
<p>E-Mail: s.neumann@reinraum-profis.example | Telefon 030 12345606</p></section>""",
        {"email": "s.neumann@reinraum-profis.example", "contact_name": "Stefan Neumann", "contact_role": "Geschäftsführer", "register_number": "HRB 165432", "legal_form": "GmbH"}),
    "normal_05": ("Frischwind Reinigung GbR", """
<h1>Impressum</h1>
<p>Frischwind Reinigung GbR<br>Sonnenallee 150<br>12059 Berlin</p>
<p>Gesellschafter: Lena Schmidt, Paul Richter</p>
<p>E-Mail: lena@frischwind-reinigung.example</p>
<p>Umsatzsteuer-ID: DE298765432</p>""",
        {"email": "lena@frischwind-reinigung.example", "contact_name": "Lena Schmidt", "contact_role": "Gesellschafter", "register_number": None, "legal_form": "GbR"}),
    "normal_06": ("Sauberzauber Dienstleistungen GmbH", """
<main><h1>Impressum</h1>
<table><tr><td>Firma</td><td>Sauberzauber Dienstleistungen GmbH</td></tr>
<tr><td>Anschrift</td><td>Frankfurter Allee 55, 10247 Berlin</td></tr>
<tr><td>Geschäftsführung</td><td>Katrin Lehmann</td></tr>
<tr><td>Handelsregister</td><td>HRB 187654 B</td></tr>
<tr><td>E-Mail</td><td><a href="mailto:k.lehmann@sauberzauber.example?subject=Anfrage">Schreiben Sie uns</a></td></tr></table></main>""",
        {"email": "k.lehmann@sauberzauber.example", "contact_name": "Katrin Lehmann", "contact_role": "Geschäftsführer", "register_number": "HRB 187654 B", "legal_form": "GmbH"}),
    "normal_07": ("Mustermann Gebäudedienste AG", """
<h1>Impressum</h1><p>Mustermann Gebäudedienste AG<br>Friedrichstraße 100, 10117 Berlin</p>
<p>Vorstand: Michael Braun (Vorsitzender), Julia Vogel</p><p>Aufsichtsratsvorsitzender: Peter Klein</p>
<p>Handelsregister: Amtsgericht Charlottenburg HRB 99887 B</p><p>E-Mail: m.braun@mustermann-gd.example</p>""",
        {"email": "m.braun@mustermann-gd.example", "contact_name": "Michael Braun", "contact_role": "Vorstand", "register_number": "HRB 99887 B", "legal_form": "AG"}),
    "normal_08": ("Elbe Reinigungstechnik GmbH & Co. KG", """
<h1>Impressum</h1><p>Elbe Reinigungstechnik GmbH &amp; Co. KG, Hafenstraße 8, 20459 Hamburg</p>
<p>Persönlich haftende Gesellschafterin: Elbe Verwaltungs GmbH, vertreten durch den Geschäftsführer Henrik Jansen</p>
<p>Geschäftsführer: Henrik Jansen</p>
<p>Amtsgericht Hamburg HRA 123456</p><p>Kontakt: service@elbe-reinigung.example, h.jansen@elbe-reinigung.example</p>""",
        {"email": "h.jansen@elbe-reinigung.example", "contact_name": "Henrik Jansen", "contact_role": "Geschäftsführer", "register_number": "HRA 123456", "legal_form": "GmbH & Co. KG"}),
    "normal_09": ("Isar Facility GmbH", """
<h1>Impressum</h1><p>Isar Facility GmbH<br>Leopoldstraße 50<br>80802 München</p>
<p>Geschäftsführer:<br>Florian Huber</p>
<p>HRB 245678 (Amtsgericht München)</p><p>E-Mail: florian.huber@isar-facility.example<br>Bewerbungen: jobs@isar-facility.example</p>""",
        {"email": "florian.huber@isar-facility.example", "contact_name": "Florian Huber", "contact_role": "Geschäftsführer", "register_number": "HRB 245678", "legal_form": "GmbH"}),
    "normal_10": ("Rhein Gebäudemanagement GmbH", """
<h1>Imprint</h1><p>Rhein Gebäudemanagement GmbH, Rheinallee 3, 50667 Köln</p>
<p>Managing Director: Sophie Wagner</p><p>Commercial register: Amtsgericht Köln, HRB 112233</p>
<p>Email: sophie.wagner@rhein-gm.example</p>""",
        {"email": "sophie.wagner@rhein-gm.example", "contact_name": "Sophie Wagner", "contact_role": "Geschäftsführer", "register_number": "HRB 112233", "legal_form": "GmbH"}),
    # ---- hard cases ----
    "hard_at_email": ("Hauptstadt Glas- und Gebäudeservice GmbH", """
<h1>Impressum</h1><p>Hauptstadt Glas- und Gebäudeservice GmbH<br>Kurfürstendamm 200<br>10719 Berlin</p>
<p>Geschäftsführer: Andreas Schulz</p>
<p>E-Mail: a.schulz [at] hauptstadt-glas [dot] example<br>oder info (at) hauptstadt-glas.example</p>
<p>HRB 176001 B</p>""",
        {"email": "a.schulz@hauptstadt-glas.example", "contact_name": "Andreas Schulz", "contact_role": "Geschäftsführer", "register_number": "HRB 176001 B", "legal_form": "GmbH"}),
    "hard_two_directors": ("Kiezsauber Facility Services GmbH", """
<h1>Impressum</h1><p>Kiezsauber Facility Services GmbH, Karl-Marx-Straße 101, 12043 Berlin</p>
<p>Geschäftsführer: Markus Wolf und Sabine Krüger</p>
<p>Registergericht: Amtsgericht Charlottenburg, HRB 176543 B</p>
<p>E-Mail: info@kiezsauber.example, m.wolf@kiezsauber.example</p>""",
        {"email": "m.wolf@kiezsauber.example", "contact_name": "Markus Wolf", "contact_names": ["Markus Wolf", "Sabine Krüger"], "contact_role": "Geschäftsführer", "register_number": "HRB 176543 B", "legal_form": "GmbH"}),
    "hard_austria": ("Donau Reinigung GmbH", """
<h1>Impressum</h1><p>Informationspflicht laut §5 E-Commerce Gesetz, §14 Unternehmensgesetzbuch</p>
<p>Donau Reinigung GmbH<br>Praterstraße 10, 1020 Wien, Österreich</p>
<p>Firmenbuchnummer: FN 456789 x<br>Firmenbuchgericht: Handelsgericht Wien</p>
<p>Geschäftsführer: Mag. Lukas Gruber</p><p>E-Mail: lukas.gruber@donau-reinigung.example</p>""",
        {"email": "lukas.gruber@donau-reinigung.example", "contact_name": "Lukas Gruber", "contact_role": "Geschäftsführer", "register_number": "FN 456789 x", "legal_form": "GmbH"}),
    "hard_switzerland": ("Zürisee Reinigung AG", """
<h1>Impressum</h1><p>Zürisee Reinigung AG<br>Seestrasse 20<br>8002 Zürich, Schweiz</p>
<p>Vertretungsberechtigte Person: Beat Meier</p>
<p>Handelsregister: CHE-123.456.789</p><p>E-Mail: beat.meier@zuerisee-reinigung.example</p>""",
        {"email": "beat.meier@zuerisee-reinigung.example", "contact_name": "Beat Meier", "contact_role": "Geschäftsführer", "register_number": "CHE-123.456.789", "legal_form": "AG"}),
    "hard_no_impressum": (None, None,
        {"email": None, "contact_name": None, "contact_role": None, "register_number": None, "legal_form": None}),
    "generic_info_only": ("Charlottenburger Hausmeister- und Reinigungsdienst GmbH", """
<h1>Impressum</h1><p>Charlottenburger Hausmeister- und Reinigungsdienst GmbH, Kantstraße 44, 10625 Berlin</p>
<p>Kontakt: info@cb-hausdienst.example</p><p>HRB 150150 B</p>""",
        {"email": "info@cb-hausdienst.example", "contact_name": None, "contact_role": None, "register_number": "HRB 150150 B", "legal_form": "GmbH"}),
}

DOMAINS_FOR_FIXTURE = {
    "normal_07": "mustermann-gd.example", "normal_08": "elbe-reinigung.example", "normal_09": "isar-facility.example",
    "normal_10": "rhein-gm.example", "hard_austria": "donau-reinigung.example", "hard_switzerland": "zuerisee-reinigung.example",
}


def page(title, inner):
    return f"""<!doctype html><html lang="de"><head><meta charset="utf-8"><title>{title}</title>
<style>body{{font-family:sans-serif}}</style><script>var tracking = "info@tracker.example";</script></head>
<body><header><nav><a href="/">Start</a> <a href="/leistungen">Leistungen</a> <a href="/kontakt">Kontakt</a></nav></header>
{inner}
<footer><a href="/datenschutz">Datenschutz</a></footer></body></html>
"""


def homepage(name, style):
    services = "Unterhaltsreinigung für Büros und Praxen, Glasreinigung und Treppenhausreinigung"
    link = '<a href="/impressum">Impressum</a>' if style == "std" else '<a href="/rechtliches/anbieter">Impressum</a>' if style == "link" else ""
    inner = f"""<main><h1>{name}</h1><p>Seit 2009 bieten wir {services} in Berlin an.
Zu unseren Kunden zählen Hausverwaltungen, Arztpraxen und mittelständische Büros.</p>
<p>Wir arbeiten mit festen Teams und dokumentieren jede Reinigung digital.</p></main>
<footer>{link}</footer>"""
    return page(name, inner)


def main():
    web_map = {}
    exp = {}
    imp_dir = ROOT / "impressum"
    imp_dir.mkdir(exist_ok=True)
    for key, (name, html, expected) in IMPRESSUM.items():
        exp[key] = expected
        if html:
            (imp_dir / f"{key}.html").write_text(page("Impressum – " + name, html), encoding="utf-8")
    (imp_dir / "hard_no_impressum.html").write_text(page("Weißensee Clean Team", "<main><h1>Willkommen</h1><p>Wir reinigen in Weißensee. Rufen Sie uns an.</p></main>"), encoding="utf-8")
    (imp_dir / "expected.json").write_text(json.dumps(exp, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    places = [place(c) for c in COMPANIES]
    resp = {"places": places}
    (ROOT / "google_places_berlin_10.json").write_text(json.dumps(resp, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    resp12 = {"places": places + EXTRA_SKIPPED}
    (ROOT / "google_places_with_skips.json").write_text(json.dumps(resp12, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    for c in COMPANIES:
        pid, name, domain, *_rest, imp, style = c
        entry = {"/": homepage(name, style)}
        if imp != "hard_no_impressum":
            path = "/rechtliches/anbieter" if style == "link" else "/impressum"
            entry[path] = f"impressum/{imp}.html"
        entry["/"] = f"web/{domain}.home.html"
        (ROOT / "web" / f"{domain}.home.html").write_text(homepage(name, style), encoding="utf-8")
        web_map[domain] = entry
    for key, domain in DOMAINS_FOR_FIXTURE.items():
        web_map[domain] = {"/impressum": f"impressum/{key}.html"}
    (ROOT / "web_map.json").write_text(json.dumps(web_map, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
