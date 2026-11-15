"""Captures ONE real Google Places (New) Text Search response as the test fixture.

Exactly 1 request, pageSize = TEST_LEAD_LIMIT (10), Module 2 field mask (Enterprise tier, no reviews/photos).
Writes tests/fixtures/google_places_berlin_10_real.json (the mock tests keep the fictional fixture). Run once; tests reuse it so they never spend quota.

Usage: python setup/capture_places_fixture.py [--query "Reinigungsunternehmen in Berlin"]
"""
import argparse
import json
import os
import pathlib

import requests
from dotenv import load_dotenv

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIELD_MASK = ("places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,"
              "places.userRatingCount,places.types,places.businessStatus,places.googleMapsUri,nextPageToken")


def capture(key, query, limit, session=requests):
    if not key:
        raise SystemExit("GOOGLE_MAPS_API_KEY is empty (see docs/blockers.md step 6)")
    limit = min(int(limit or 10), 10)  # never more than the test limit
    r = session.post("https://places.googleapis.com/v1/places:searchText",
                     headers={"X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELD_MASK, "Content-Type": "application/json"},
                     json={"textQuery": query, "languageCode": "de", "regionCode": "DE", "pageSize": limit}, timeout=30)
    r.raise_for_status()
    data = r.json()
    data.pop("nextPageToken", None)
    return data


def main():
    load_dotenv(ROOT / ".env")
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", default="Reinigungsunternehmen in Berlin")
    ap.add_argument("--out", default="tests/fixtures/google_places_berlin_10_real.json",
                    help="the mock tests use google_places_berlin_10.json (fictional companies); the real capture is kept separately")
    a = ap.parse_args()
    data = capture(os.environ.get("GOOGLE_MAPS_API_KEY"), a.query, os.environ.get("TEST_LEAD_LIMIT", "10"))
    out = ROOT / a.out
    out.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"saved {len(data.get('places', []))} places to {out.relative_to(ROOT)} (1 Google request)")


if __name__ == "__main__":
    main()
