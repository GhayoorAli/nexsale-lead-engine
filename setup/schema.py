"""Airtable schema for the base "Nexsale Lead Engine" (9 tables, PLAN.md "Architecture and data model").

Field types follow the Airtable Meta API. The first field of each table is its primary field.
Notes:
- Autonumber IDs (client_id, lead_id, …) cannot be created through the Meta API. Workflows use the
  Airtable record ID (also stored in the *_record_id text fields used for filtering), so the
  autonumber fields are optional; see docs/blockers.md to add them by hand.
- Link fields are created in a second pass, after all tables exist.
"""
TZ = "Europe/Berlin"
DT = {"type": "dateTime", "options": {"dateFormat": {"name": "iso"}, "timeFormat": {"name": "24hour"}, "timeZone": TZ}}


def t(name):
    return {"name": name, "type": "singleLineText"}


def long(name):
    return {"name": name, "type": "multilineText"}


def num(name, precision=0):
    return {"name": name, "type": "number", "options": {"precision": precision}}


def dt(name):
    return dict(DT, name=name)


def url(name):
    return {"name": name, "type": "url"}


def email(name):
    return {"name": name, "type": "email"}


def check(name):
    return {"name": name, "type": "checkbox", "options": {"icon": "check", "color": "greenBright"}}


def select(name, options):
    return {"name": name, "type": "singleSelect", "options": {"choices": [{"name": o} for o in options]}}


LEAD_STATUS = ["New", "Enriching", "Enriched", "Rejected", "Drafting", "Drafted", "Approved", "Needs review", "Contacted", "Replied",
               "Interested", "Later", "Meeting booked", "Meeting held", "No-show", "Not interested", "Unsubscribed", "Bounced"]
REPLY_CATS = ["Interested", "Question", "Referral", "Later", "Not interested", "Unsubscribe", "Out of office", "Unclear", "Bounce"]

TABLES = {
    "Clients": [t("name"), t("industry"), url("calendly_link"), t("sender_name"), t("sender_title"), t("sender_company"), t("sender_phone"), url("sender_website"),
                long("sender_company_footer"), long("offer"), check("is_default"), long("qualifying_questions"), t("target_segments"),
                num("target_positive_replies"), num("target_meetings"), t("hubspot_owner_id"), t("slack_channel"),
                num("positive_replies_month"), num("meetings_month"), num("positive_pct", 1), num("meetings_pct", 1), dt("metrics_updated_at")],
    "Campaigns": [t("name"), t("client_record_id"), t("industry"), t("city"), t("company_size"), t("target_role"), num("max_leads"),
                  select("status", ["Draft", "Sourcing", "Ready", "Launch", "Live", "Paused", "Completed"]), num("daily_limit"),
                  t("subject_a"), t("subject_b"), dt("created_at"), dt("ready_at"), dt("launched_at"), t("launched_by"), long("launch_failures"),
                  num("google_api_requests"), num("google_api_cost_eur", 4), num("ai_cost_eur", 4), t("slack_ts"), t("slack_channel"),
                  num("leads_sourced"), num("enriched_pct", 1), num("emails_sent"), num("reply_rate_pct", 1), num("positive_replies"),
                  num("meetings_booked"), num("meetings_held"), num("cost_per_lead_eur", 4), num("cost_per_meeting_eur", 4), dt("metrics_updated_at")],
    "Leads": [t("company_name"), t("google_name"), t("campaign_record_id"), t("domain"), url("website"), t("phone"), t("address"), t("city"),
              t("google_place_id"), num("google_rating", 1), num("review_count"), url("google_maps_uri"),
              t("contact_name"), t("contact_role"), t("contact_salutation"), t("contact_source"), long("trigger"), long("meeting_brief"), email("email"), long("emails_found"), t("register_number"), t("legal_form"),
              check("hiring_signal"), check("mx_ok"), long("company_summary"), num("score"), t("score_breakdown"), t("reject_reason"),
              select("status", LEAD_STATUS), t("needs_review_reason"), t("source"), dt("sourced_at"),
              select("lead_type", ["Outbound", "Inbound quiz", "Inbound ad"]), long("inbound_answers"), t("inbound_temperature"),
              num("sequence_step"), dt("next_send_at"), dt("first_sent_at"), check("sequence_finished"), select("subject_variant", ["A", "B"]),
              select("last_reply_category", REPLY_CATS), dt("follow_up_at"), dt("bounced_at"), dt("claimed_at"), num("quality_score"),
              t("hubspot_contact_id"), t("hubspot_company_id"), t("hubspot_deal_id"), t("crm_synced_status")],
    "Emails": [t("key"), t("lead_record_id"), t("campaign_record_id"), num("step"), t("subject"), t("subject_b"), long("body"),
               check("approved"), num("quality_score"), select("status", ["Draft", "Approved", "Sent", "Skipped"]), dt("sent_at"),
               t("gmail_message_id"), t("thread_id"), t("subject_sent"), t("sent_to"), t("original_to")],
    "Replies": [t("key"), t("lead_record_id"), dt("received_at"), t("from_email"), t("subject"), long("body"),
                select("category", REPLY_CATS), num("ai_confidence", 2), t("classified_by"), long("summary"), long("suggested_reply"),
                check("reply_approved"), t("handled_by"), dt("handled_at"), t("branch"), t("thread_id"), t("gmail_message_id"), t("slack_ts"), t("slack_channel")],
    "Meetings": [t("key"), t("lead_record_id"), t("calendly_event_id"), dt("start_time"), t("invitee_email"),
                 select("status", ["Booked", "Reminded", "Held", "No-show", "Cancelled"]), dt("reminder_sent_at"), dt("held_check_sent_at"),
                 t("slack_ts"), t("slack_channel")],
    "Blocklist": [t("value"), t("reason"), dt("added_at")],
    "Logs": [t("key"), t("workflow"), t("lead_record_id"), select("level", ["info", "error"]), long("message"), t("node"), url("execution_url"), dt("created_at")],
    "Tasks": [t("key"), t("lead_record_id"), select("type", ["Call inbound lead", "Call no-show", "Follow up later", "Follow up referral"]), dt("due_at"),
              t("assigned_to"), long("summary"), select("status", ["Open", "Done"]), t("slack_ts"), t("slack_channel")],
}

# (table, field, linked table) – created after all tables exist
LINKS = [("Campaigns", "client", "Clients"), ("Leads", "campaign", "Campaigns"), ("Emails", "lead", "Leads"),
         ("Replies", "lead", "Leads"), ("Meetings", "lead", "Leads"), ("Logs", "lead", "Leads"), ("Tasks", "lead", "Leads")]
