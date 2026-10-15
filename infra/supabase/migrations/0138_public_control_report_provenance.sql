-- Versioned report provenance for finalized source-linked assessments only.
-- No new report authority, release decision, verified-evidence claim or worker codec.
-- Immutable compiled mapping bytes, not a caller supplied manifest or writer.
create function controller_security.public_control_report_mapping_manifest() returns text
language sql immutable set search_path='' as $function$ select $manifest${"schemaVersion":2,"mappingVersion":"public-evidence-1","provenance":{"libraryVersion":"0.1.1","publishedAt":"2026-09-20","publisher":"Axiom Minds · Founder","baseline":"IN-DPDP@2026-09-20","defaultEffectiveFrom":"2027-05-13","perControlEffectiveDates":"not_present_in_source","effectiveStatus":"requires_assessment_date_and_legal_review","publicationVerification":"requires_exact_published_catalogue_comparison"},"controls":[{"control":{"id":"DPDPA-GOV-001","title":"Designate a data fiduciary accountable for DPDPA compliance","domain":"GOV","severity":"critical","obligation":"Every entity that determines the purpose and means of processing digital personal data is a Data Fiduciary and bears primary statutory accountability under Section 8 of the DPDP Act, regardless of contract structure.","citations":[{"instrument":"DPDPA-2023","reference":"Section 2(i), 2(k), 8(1)"}],"evidenceRequired":[{"type":"document","description":"Board resolution or partnership deed naming the Data Fiduciary entity"},{"type":"config","description":"Authoritative organisational record (MCA / GST filing) showing the entity"}],"assessmentQuestions":[{"id":"Q1","prompt":"Is there a single legal entity formally identified as the Data Fiduciary for the personal data you process?","type":"boolean","evidenceTypes":["document","config"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":30,"maxPenaltyINR":250000000},"remediationPatterns":["dpo-appointment","review"],"tags":["foundation","always-applies"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["entity"],"questions":[{"questionId":"Q1","publicCandidateFacets":["entity"],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Board resolution or partnership deed naming the Data Fiduciary entity"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"config","description":"Authoritative organisational record (MCA / GST filing) showing the entity"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-GOV-002","title":"Publish a privacy policy covering all processing activities","domain":"GOV","severity":"high","obligation":"A publicly accessible privacy policy must describe the personal data processed, the purposes, the rights of data principals, and contact information for grievance redressal (Section 5(3) read with Rule 3).","citations":[{"instrument":"DPDPA-2023","reference":"Section 5(3)"},{"instrument":"DPDPR-2025","reference":"Rule 3"}],"evidenceRequired":[{"type":"document","description":"Public privacy policy URL with version + effective date"},{"type":"screenshot","description":"Live screenshot of the published policy"}],"assessmentQuestions":[{"id":"Q1","prompt":"Do you have a publicly accessible privacy policy that meets Section 5(3) requirements?","type":"boolean","evidenceTypes":["document","screenshot"],"dependsOn":[]},{"id":"Q2","prompt":"When was the policy last reviewed and is the version date visible on the page?","type":"evidence","evidenceTypes":["screenshot"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":18,"maxPenaltyINR":50000000},"remediationPatterns":["policy"],"tags":["always-applies","public-facing"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["privacy_notice"],"questions":[{"questionId":"Q1","publicCandidateFacets":["privacy_notice"],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":["privacy_notice"],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Public privacy policy URL with version + effective date"},"publicCandidateFacets":["privacy_notice"],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"screenshot","description":"Live screenshot of the published policy"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-GOV-003","title":"Maintain a written data-processing agreement with every Data Processor","domain":"GOV","severity":"high","obligation":"Personal data may be processed by a Data Processor only under a valid contract that limits processing to the Data Fiduciary's instructions, enforces security safeguards, and binds the processor to the Act (Section 8(1), Rule 6).","citations":[{"instrument":"DPDPA-2023","reference":"Section 8(1), 2(l)"},{"instrument":"DPDPR-2025","reference":"Rule 6"}],"evidenceRequired":[{"type":"document","description":"Signed DPA with each processor covering scope, security, sub-processors, return/deletion"}],"assessmentQuestions":[{"id":"Q1","prompt":"List all third parties that process personal data on your behalf (Data Processors).","type":"text","evidenceTypes":["document"],"dependsOn":[]},{"id":"Q2","prompt":"For each processor, is there a signed DPA that meets Rule 6 requirements?","type":"evidence","evidenceTypes":["document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":20,"maxPenaltyINR":50000000},"remediationPatterns":["dpa-execution","vendor-risk"],"tags":["always-applies","vendor"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["processor_disclosure"],"questions":[{"questionId":"Q1","publicCandidateFacets":["processor_disclosure"],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Signed DPA with each processor covering scope, security, sub-processors, return/deletion"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-CNS-001","title":"Obtain free, specific, informed, unconditional, unambiguous consent","domain":"CNS","severity":"critical","obligation":"Consent must be free, specific, informed, unconditional and unambiguous, with a clear affirmative action, and must be capable of being withdrawn as easily as it was given (Section 6(1)–(4)).","citations":[{"instrument":"DPDPA-2023","reference":"Section 6(1), 6(2), 6(3), 6(4)"},{"instrument":"DPDPR-2025","reference":"Rule 3"}],"evidenceRequired":[{"type":"screenshot","description":"Screenshot of the consent capture UX showing it is un-bundled and affirmative"},{"type":"log","description":"Sample of consent records with timestamp and version of notice shown"}],"assessmentQuestions":[{"id":"Q1","prompt":"Is consent obtained via a clear affirmative action (not pre-ticked boxes or implied consent)?","type":"boolean","evidenceTypes":["screenshot","config"],"dependsOn":[]},{"id":"Q2","prompt":"Is the consent notice shown at the time of consent and version-pinned?","type":"boolean","evidenceTypes":["screenshot","log"],"dependsOn":[]},{"id":"Q3","prompt":"Can the data principal withdraw consent as easily as they gave it?","type":"boolean","evidenceTypes":["screenshot","config"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":35,"maxPenaltyINR":250000000},"remediationPatterns":["consent","policy"],"tags":["always-applies","first-principle"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["consent_ui","notice_at_collection","withdrawal"],"questions":[{"questionId":"Q1","publicCandidateFacets":["consent_ui"],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":["notice_at_collection"],"internalVerificationRequired":true},{"questionId":"Q3","publicCandidateFacets":["withdrawal"],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"screenshot","description":"Screenshot of the consent capture UX showing it is un-bundled and affirmative"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"log","description":"Sample of consent records with timestamp and version of notice shown"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-CNS-002","title":"Issue notice before or alongside consent specifying purpose, items, and rights","domain":"CNS","severity":"high","obligation":"Before seeking consent the Data Fiduciary must issue a notice describing the personal data and the purpose of processing, the manner of exercising rights, and the means of making a complaint (Section 5(1)–(2), Rule 3).","citations":[{"instrument":"DPDPA-2023","reference":"Section 5(1), 5(2)"},{"instrument":"DPDPR-2025","reference":"Rule 3"}],"evidenceRequired":[{"type":"document","description":"Consent notice text showing all required items"},{"type":"screenshot","description":"Live UI showing notice at point of consent"}],"assessmentQuestions":[{"id":"Q1","prompt":"Does the notice describe the personal data items being collected and the specific purpose?","type":"boolean","evidenceTypes":["document"],"dependsOn":[]},{"id":"Q2","prompt":"Does the notice explain how to exercise rights and how to make a complaint?","type":"boolean","evidenceTypes":["document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":20,"maxPenaltyINR":50000000},"remediationPatterns":["policy","consent"],"tags":["always-applies"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["notice_at_collection","data_items_purposes"],"questions":[{"questionId":"Q1","publicCandidateFacets":["data_items_purposes","notice_at_collection"],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":["access_right","grievance_contact"],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Consent notice text showing all required items"},"publicCandidateFacets":["notice_at_collection","data_items_purposes"],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"screenshot","description":"Live UI showing notice at point of consent"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-CNS-003","title":"Maintain a consent ledger with at least 7-year retention","domain":"CNS","severity":"high","obligation":"Records of consent — including the notice version, the data principal identifier, the timestamp, and the items consented to — must be retained for at least 7 years from the date of consent or last action, whichever is later (Rule 4 read with the First Schedule).","citations":[{"instrument":"DPDPR-2025","reference":"Rule 4 and First Schedule"}],"evidenceRequired":[{"type":"config","description":"Schema + retention policy showing 7-year retention on consent records"},{"type":"log","description":"Sample consent record with all required fields"}],"assessmentQuestions":[{"id":"Q1","prompt":"Do you store a record of every consent with timestamp + notice version + items + data principal ID?","type":"boolean","evidenceTypes":["config","log"],"dependsOn":[]},{"id":"Q2","prompt":"Is the retention period at least 7 years?","type":"boolean","evidenceTypes":["config"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":18,"maxPenaltyINR":50000000},"remediationPatterns":["config","policy"],"tags":["always-applies","retention"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["retention_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"config","description":"Schema + retention policy showing 7-year retention on consent records"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"log","description":"Sample consent record with all required fields"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-CNS-004","title":"Honor consent withdrawal and erase related data","domain":"CNS","severity":"critical","obligation":"On withdrawal of consent, processing must stop and personal data must be erased within a reasonable time, except where retention is necessary for legal obligation (Section 6(4), 8(7)).","citations":[{"instrument":"DPDPA-2023","reference":"Section 6(4), 8(7)"}],"evidenceRequired":[{"type":"log","description":"Withdrawal workflow showing receipt → action → completion"},{"type":"attestation","description":"Policy on what is erased vs retained and why"}],"assessmentQuestions":[{"id":"Q1","prompt":"Is there a working mechanism for users to withdraw consent?","type":"boolean","evidenceTypes":["screenshot","config"],"dependsOn":[]},{"id":"Q2","prompt":"After withdrawal, is the user's personal data erased from active systems within a reasonable time?","type":"boolean","evidenceTypes":["log","attestation"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":30,"maxPenaltyINR":250000000},"remediationPatterns":["data-deletion","consent","config"],"tags":["always-applies","rights"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["withdrawal","correction_erasure"],"questions":[{"questionId":"Q1","publicCandidateFacets":["withdrawal"],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"log","description":"Withdrawal workflow showing receipt → action → completion"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"attestation","description":"Policy on what is erased vs retained and why"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-CNS-005","title":"Publish an itemised list of personal data collected for each purpose","domain":"CNS","severity":"medium","obligation":"The notice must itemise the personal data being collected and the specific purpose, not generic categories. \"Personal data\" must be itemised at a level a data principal can understand and consent to specifically.","citations":[{"instrument":"DPDPA-2023","reference":"Section 5(1)(b)"},{"instrument":"DPDPR-2025","reference":"Rule 3"}],"evidenceRequired":[{"type":"document","description":"Notice text showing itemised fields"}],"assessmentQuestions":[{"id":"Q1","prompt":"For each processing purpose, does the notice itemise the specific data fields collected?","type":"boolean","evidenceTypes":["document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":12,"maxPenaltyINR":50000000},"remediationPatterns":["policy"],"tags":["always-applies"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["data_items_purposes"],"questions":[{"questionId":"Q1","publicCandidateFacets":["data_items_purposes"],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Notice text showing itemised fields"},"publicCandidateFacets":["data_items_purposes"],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-DAT-001","title":"Provide a right-of-access mechanism (summary of personal data held)","domain":"DAT","severity":"high","obligation":"A data principal has the right to obtain a summary of their personal data being processed and the related processing activities (Section 11(1), Rule 14).","citations":[{"instrument":"DPDPA-2023","reference":"Section 11(1)"},{"instrument":"DPDPR-2025","reference":"Rule 14"}],"evidenceRequired":[{"type":"config","description":"DSAR intake + identity verification flow"},{"type":"log","description":"Sample of past fulfilled access requests"}],"assessmentQuestions":[{"id":"Q1","prompt":"Can a data principal request a copy of their personal data you hold?","type":"boolean","evidenceTypes":["screenshot","config"],"dependsOn":[]},{"id":"Q2","prompt":"Within what timeframe do you respond?","type":"text","evidenceTypes":["attestation"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":20,"maxPenaltyINR":50000000},"remediationPatterns":["review","policy","data-portability"],"tags":["always-applies","rights"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["access_right"],"questions":[{"questionId":"Q1","publicCandidateFacets":["access_right"],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"config","description":"DSAR intake + identity verification flow"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"log","description":"Sample of past fulfilled access requests"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-DAT-002","title":"Provide right to correction and erasure of personal data","domain":"DAT","severity":"high","obligation":"A data principal may request correction or erasure of their personal data where it is incomplete, inaccurate, or no longer necessary (Section 12, Rule 14).","citations":[{"instrument":"DPDPA-2023","reference":"Section 12"},{"instrument":"DPDPR-2025","reference":"Rule 14"}],"evidenceRequired":[{"type":"config","description":"Correction/erasure request workflow"},{"type":"log","description":"Sample of completed correction/erasure requests"}],"assessmentQuestions":[{"id":"Q1","prompt":"Can a data principal request correction of inaccurate personal data?","type":"boolean","evidenceTypes":["screenshot","config"],"dependsOn":[]},{"id":"Q2","prompt":"Can a data principal request erasure of personal data, and do you action it across all systems (including processors)?","type":"boolean","evidenceTypes":["screenshot","config","log"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":22,"maxPenaltyINR":50000000},"remediationPatterns":["data-deletion","config","policy"],"tags":["always-applies","rights"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["correction_erasure"],"questions":[{"questionId":"Q1","publicCandidateFacets":["correction_erasure"],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":["correction_erasure"],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"config","description":"Correction/erasure request workflow"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"log","description":"Sample of completed correction/erasure requests"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-DAT-003","title":"Operate a grievance redressal mechanism with named contact","domain":"DAT","severity":"high","obligation":"The Data Fiduciary must establish a grievance redressal mechanism and respond to data principal complaints within 30 days, with the name and contact details of the grievance officer published (Section 13(1), Rule 14).","citations":[{"instrument":"DPDPA-2023","reference":"Section 13(1)"},{"instrument":"DPDPR-2025","reference":"Rule 14"}],"evidenceRequired":[{"type":"document","description":"Published grievance officer name and contact"},{"type":"log","description":"Grievance ticketing with response time tracking"}],"assessmentQuestions":[{"id":"Q1","prompt":"Is the grievance officer name and contact publicly available?","type":"boolean","evidenceTypes":["document","screenshot"],"dependsOn":[]},{"id":"Q2","prompt":"Do you respond to complaints within 30 days?","type":"boolean","evidenceTypes":["log","attestation"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":18,"maxPenaltyINR":50000000},"remediationPatterns":["policy","dpo-appointment"],"tags":["always-applies"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["grievance_contact"],"questions":[{"questionId":"Q1","publicCandidateFacets":["grievance_contact"],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Published grievance officer name and contact"},"publicCandidateFacets":["grievance_contact"],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"log","description":"Grievance ticketing with response time tracking"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-DAT-004","title":"Provide right to nominate another individual","domain":"DAT","severity":"medium","obligation":"A data principal may nominate another individual to exercise their rights in the event of death or incapacity (Section 14).","citations":[{"instrument":"DPDPA-2023","reference":"Section 14"}],"evidenceRequired":[{"type":"config","description":"Nomination feature in user account"},{"type":"document","description":"Notice describing the right"}],"assessmentQuestions":[{"id":"Q1","prompt":"Can a user nominate another individual to exercise their rights?","type":"boolean","evidenceTypes":["screenshot","config"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":8,"maxPenaltyINR":20000000},"remediationPatterns":["config","policy"],"tags":["always-applies","rights"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["nomination"],"questions":[{"questionId":"Q1","publicCandidateFacets":["nomination"],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"config","description":"Nomination feature in user account"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"document","description":"Notice describing the right"},"publicCandidateFacets":["nomination"],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-RCD-001","title":"Maintain a Record of Processing Activities (RoPA)","domain":"RCD","severity":"high","obligation":"The Data Fiduciary must maintain accurate and up-to-date records of its processing activities, sufficient to demonstrate compliance (Rule 8 read with the Third Schedule).","citations":[{"instrument":"DPDPR-2025","reference":"Rule 8 and Third Schedule"},{"instrument":"DPDPA-2023","reference":"Section 8"}],"evidenceRequired":[{"type":"inventory","description":"Living RoPA — purpose, data items, lawful basis, processors, retention, cross-border"}],"assessmentQuestions":[{"id":"Q1","prompt":"Do you maintain a written Record of Processing Activities?","type":"boolean","evidenceTypes":["inventory","document"],"dependsOn":[]},{"id":"Q2","prompt":"Is it updated within 30 days of any change in processing?","type":"boolean","evidenceTypes":["attestation"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":18,"maxPenaltyINR":50000000},"remediationPatterns":["discovery","reporting"],"tags":["always-applies","core"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["data_items_purposes"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"inventory","description":"Living RoPA — purpose, data items, lawful basis, processors, retention, cross-border"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-RCD-002","title":"Capture a complete data inventory (systems, fields, flows)","domain":"RCD","severity":"high","obligation":"The RoPA must be backed by an actual inventory of systems, databases, fields and data flows — not a generic narrative. Records must be available on demand to the Data Protection Board.","citations":[{"instrument":"DPDPR-2025","reference":"Rule 6"}],"evidenceRequired":[{"type":"inventory","description":"System-level inventory with field-level personal-data classification"}],"assessmentQuestions":[{"id":"Q1","prompt":"Have you inventoried all systems that hold personal data?","type":"boolean","evidenceTypes":["inventory"],"dependsOn":[]},{"id":"Q2","prompt":"Is the inventory field-level (not just system-level)?","type":"boolean","evidenceTypes":["inventory"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":18,"maxPenaltyINR":50000000},"remediationPatterns":["discovery"],"tags":["always-applies","core"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["data_items_purposes"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"inventory","description":"System-level inventory with field-level personal-data classification"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-BRCH-001","title":"Notify the Data Protection Board of a personal data breach","domain":"BRCH","severity":"critical","obligation":"On becoming aware of a personal data breach, the Data Fiduciary must inform the Data Protection Board and the affected data principals in the manner and within the time prescribed (Section 8(6), Rules 19–20).","citations":[{"instrument":"DPDPA-2023","reference":"Section 8(6)"},{"instrument":"DPDPR-2025","reference":"Rule 7"}],"evidenceRequired":[{"type":"document","description":"Breach response runbook with 72-hour DPB clock"},{"type":"log","description":"Forensic log capture capability"}],"assessmentQuestions":[{"id":"Q1","prompt":"Do you have a documented breach response procedure?","type":"boolean","evidenceTypes":["document"],"dependsOn":[]},{"id":"Q2","prompt":"Can you meet the statutory notification clock (typically 72 hours from awareness)?","type":"boolean","evidenceTypes":["attestation","log"],"dependsOn":[]},{"id":"Q3","prompt":"Do you have forensic log capture sufficient to reconstruct a breach?","type":"boolean","evidenceTypes":["log","config"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":40,"maxPenaltyINR":250000000},"remediationPatterns":["breach-process","policy"],"tags":["always-applies","high-stakes"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["breach_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":[],"internalVerificationRequired":true},{"questionId":"Q3","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Breach response runbook with 72-hour DPB clock"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"log","description":"Forensic log capture capability"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-BRCH-002","title":"Notify affected data principals of a breach where harm is likely","domain":"BRCH","severity":"high","obligation":"Where a breach is likely to cause harm to a data principal, the Data Fiduciary must inform affected principals without delay, in plain language, of the nature of the breach and the protective measures (Rule 7).","citations":[{"instrument":"DPDPR-2025","reference":"Rule 7"}],"evidenceRequired":[{"type":"document","description":"Principal notification template and trigger criteria"}],"assessmentQuestions":[{"id":"Q1","prompt":"Do you have a template for notifying affected principals?","type":"boolean","evidenceTypes":["document"],"dependsOn":[]},{"id":"Q2","prompt":"Is the trigger criteria for principal notification defined?","type":"boolean","evidenceTypes":["document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":22,"maxPenaltyINR":50000000},"remediationPatterns":["breach-process","policy"],"tags":["always-applies"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["breach_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Principal notification template and trigger criteria"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-XBR-001","title":"Restrict cross-border transfer to countries not on the restricted list","domain":"XBR","severity":"high","obligation":"Personal data may be transferred outside India only to countries or territories not specifically restricted by the Central Government via notification (Section 16, Rule 15).","citations":[{"instrument":"DPDPA-2023","reference":"Section 16"},{"instrument":"DPDPR-2025","reference":"Rule 15"}],"evidenceRequired":[{"type":"inventory","description":"Data flow map showing all cross-border destinations"},{"type":"document","description":"Policy and DPA clauses restricting transfer to allowed jurisdictions"}],"assessmentQuestions":[{"id":"Q1","prompt":"Do you transfer any personal data outside India?","type":"boolean","evidenceTypes":["inventory"],"dependsOn":[]},{"id":"Q2","prompt":"If yes, are all destinations confirmed not on the restricted list (as notified by the Central Government)?","type":"boolean","evidenceTypes":["document","attestation"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":25,"maxPenaltyINR":50000000},"remediationPatterns":["vendor-risk","dpa-execution","policy"],"tags":["always-applies","cross-border"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["transfer_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":["transfer_statement"],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"inventory","description":"Data flow map showing all cross-border destinations"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"document","description":"Policy and DPA clauses restricting transfer to allowed jurisdictions"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-XBR-002","title":"Document the legal basis for any cross-border transfer","domain":"XBR","severity":"medium","obligation":"Every cross-border transfer must be supported by a specific contract clause, consent, or other lawful basis that meets Section 16 requirements.","citations":[{"instrument":"DPDPA-2023","reference":"Section 16"}],"evidenceRequired":[{"type":"document","description":"Transfer impact assessment or contract clauses"}],"assessmentQuestions":[{"id":"Q1","prompt":"For each cross-border transfer, is the legal basis documented?","type":"boolean","evidenceTypes":["document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":15,"maxPenaltyINR":50000000},"remediationPatterns":["dpa-execution","policy"],"tags":["cross-border"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["transfer_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Transfer impact assessment or contract clauses"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-CHD-001","title":"Obtain verifiable parental consent before processing children's data","domain":"CHD","severity":"critical","obligation":"Personal data of children (under 18) may be processed only with verifiable parental consent, and processing must not be detrimental to the well-being of the child (Section 9, Rule 10).","citations":[{"instrument":"DPDPA-2023","reference":"Section 9"},{"instrument":"DPDPR-2025","reference":"Rule 10"}],"evidenceRequired":[{"type":"config","description":"Age-gate + parental consent flow"},{"type":"document","description":"Age-appropriate notice language"}],"assessmentQuestions":[{"id":"Q1","prompt":"Do you process data of children (users under 18)?","type":"boolean","evidenceTypes":["inventory"],"dependsOn":[]},{"id":"Q2","prompt":"If yes, do you obtain verifiable parental consent before processing?","type":"boolean","evidenceTypes":["config","log"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":35,"maxPenaltyINR":250000000},"remediationPatterns":["consent","config","policy"],"tags":["children"],"sdfOnly":false,"childrenOnly":true,"introducedInVersion":"0.1.0"},"applicability":"children_processing_requires_verification","publicCandidateFacets":["children_statement","parental_consent_ui"],"questions":[{"questionId":"Q1","publicCandidateFacets":["children_statement"],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":["parental_consent_ui"],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"config","description":"Age-gate + parental consent flow"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"document","description":"Age-appropriate notice language"},"publicCandidateFacets":["children_statement"],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-CHD-002","title":"Refuse to undertake tracking or behavioural monitoring of children","domain":"CHD","severity":"high","obligation":"Data Fiduciaries must not undertake tracking, behavioural monitoring, or targeted advertising directed at children (Section 9(2), Rule 10).","citations":[{"instrument":"DPDPA-2023","reference":"Section 9(2)"},{"instrument":"DPDPR-2025","reference":"Rule 10"}],"evidenceRequired":[{"type":"config","description":"Ad-tech and analytics exclusion for child users"},{"type":"attestation","description":"Internal policy on no-targeted-ads-to-children"}],"assessmentQuestions":[{"id":"Q1","prompt":"Do you run any tracking, behavioural monitoring, or targeted advertising that could reach children?","type":"boolean","evidenceTypes":["config","attestation"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":25,"maxPenaltyINR":50000000},"remediationPatterns":["config","policy"],"tags":["children"],"sdfOnly":false,"childrenOnly":true,"introducedInVersion":"0.1.0"},"applicability":"children_processing_requires_verification","publicCandidateFacets":["children_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":["children_statement"],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"config","description":"Ad-tech and analytics exclusion for child users"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"attestation","description":"Internal policy on no-targeted-ads-to-children"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-SDF-001","title":"Appoint a Data Protection Officer (India-based, named)","domain":"SDF","severity":"high","obligation":"A Significant Data Fiduciary must appoint a Data Protection Officer based in India who reports to the board, and publish their name and contact (Section 10, Rule 13).","citations":[{"instrument":"DPDPA-2023","reference":"Section 10"},{"instrument":"DPDPR-2025","reference":"Rule 13"}],"evidenceRequired":[{"type":"document","description":"DPO appointment letter, India-based address, board reporting line"},{"type":"config","description":"Public DPO contact on website"}],"assessmentQuestions":[{"id":"Q1","prompt":"Have you been designated as a Significant Data Fiduciary by the Central Government?","type":"boolean","evidenceTypes":["document","attestation"],"dependsOn":[]},{"id":"Q2","prompt":"If yes, have you appointed a Data Protection Officer based in India and published their contact?","type":"boolean","evidenceTypes":["document","screenshot"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":22,"maxPenaltyINR":50000000},"remediationPatterns":["dpo-appointment","policy"],"tags":["SDF"],"sdfOnly":true,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"sdf_status_requires_verification","publicCandidateFacets":["dpo_contact"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":["dpo_contact"],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"DPO appointment letter, India-based address, board reporting line"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"config","description":"Public DPO contact on website"},"publicCandidateFacets":["dpo_contact"],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-SDF-002","title":"Conduct periodic Data Protection Impact Assessments (DPIA)","domain":"SDF","severity":"high","obligation":"A Significant Data Fiduciary must conduct periodic Data Protection Impact Assessments, including for any processing that is likely to cause harm to a data principal (Section 10, Rule 13).","citations":[{"instrument":"DPDPA-2023","reference":"Section 10"},{"instrument":"DPDPR-2025","reference":"Rule 13"}],"evidenceRequired":[{"type":"document","description":"DPIA template + completed DPIA artifacts"}],"assessmentQuestions":[{"id":"Q1","prompt":"Are DPIAs conducted at least annually, and prior to any new high-risk processing?","type":"boolean","evidenceTypes":["document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":20,"maxPenaltyINR":50000000},"remediationPatterns":["review","reporting","policy"],"tags":["SDF"],"sdfOnly":true,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"sdf_status_requires_verification","publicCandidateFacets":["dpia_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"DPIA template + completed DPIA artifacts"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-SDF-003","title":"Submit to periodic audit by an independent Data Auditor","domain":"SDF","severity":"high","obligation":"A Significant Data Fiduciary must be audited periodically by an independent Data Auditor, and the audit report must be submitted to the Board (Section 10, Rule 13).","citations":[{"instrument":"DPDPA-2023","reference":"Section 10"},{"instrument":"DPDPR-2025","reference":"Rule 13"}],"evidenceRequired":[{"type":"document","description":"Independent audit engagement + latest audit report"}],"assessmentQuestions":[{"id":"Q1","prompt":"Are you audited annually by an independent Data Auditor?","type":"boolean","evidenceTypes":["document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":20,"maxPenaltyINR":50000000},"remediationPatterns":["reporting","vendor-risk"],"tags":["SDF"],"sdfOnly":true,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"sdf_status_requires_verification","publicCandidateFacets":["audit_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Independent audit engagement + latest audit report"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-SEC-001","title":"Implement reasonable security safeguards (technical + organisational)","domain":"SEC","severity":"critical","obligation":"The Data Fiduciary must protect personal data in its possession by taking reasonable security safeguards to prevent personal data breach (Section 8(5)). Failure constitutes grounds for the highest penalty tier under Section 33(7).","citations":[{"instrument":"DPDPA-2023","reference":"Section 8(5)"},{"instrument":"DPDPR-2025","reference":"Rule 6"}],"evidenceRequired":[{"type":"config","description":"Encryption at rest + in transit, access controls, MFA, logging"},{"type":"document","description":"Security policy + incident response plan"}],"assessmentQuestions":[{"id":"Q1","prompt":"Is personal data encrypted at rest (AES-256 or equivalent) and in transit (TLS 1.2+)?","type":"boolean","evidenceTypes":["config"],"dependsOn":[]},{"id":"Q2","prompt":"Is multi-factor authentication enforced for administrative access to personal data stores?","type":"boolean","evidenceTypes":["config"],"dependsOn":[]},{"id":"Q3","prompt":"Is access to personal data logged and reviewed?","type":"boolean","evidenceTypes":["log","config"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":50,"maxPenaltyINR":250000000},"remediationPatterns":["config","policy","training"],"tags":["always-applies","foundation"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["security_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":[],"internalVerificationRequired":true},{"questionId":"Q3","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"config","description":"Encryption at rest + in transit, access controls, MFA, logging"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"document","description":"Security policy + incident response plan"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-SEC-002","title":"Enforce least-privilege access to personal data","domain":"SEC","severity":"high","obligation":"Access to personal data must be limited to personnel who require it for the documented purpose, with role-based access controls and periodic access review.","citations":[{"instrument":"DPDPA-2023","reference":"Section 8(5)"}],"evidenceRequired":[{"type":"config","description":"RBAC configuration + access review logs"}],"assessmentQuestions":[{"id":"Q1","prompt":"Is access to personal data gated by role-based access control?","type":"boolean","evidenceTypes":["config"],"dependsOn":[]},{"id":"Q2","prompt":"Are access rights reviewed at least annually?","type":"boolean","evidenceTypes":["log","attestation"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":20,"maxPenaltyINR":50000000},"remediationPatterns":["config","review","policy"],"tags":["always-applies"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":[],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"config","description":"RBAC configuration + access review logs"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-SEC-003","title":"Maintain audit logs of access and processing of personal data","domain":"SEC","severity":"high","obligation":"Comprehensive, tamper-evident logs of who accessed or processed personal data, when, and for what purpose must be maintained for forensic and regulatory use.","citations":[{"instrument":"DPDPA-2023","reference":"Section 8(5)"}],"evidenceRequired":[{"type":"log","description":"Append-only, hash-chained audit ledger"}],"assessmentQuestions":[{"id":"Q1","prompt":"Are all access and processing events recorded to an append-only audit log?","type":"boolean","evidenceTypes":["log","config"],"dependsOn":[]},{"id":"Q2","prompt":"Is the log tamper-evident (e.g. hash-chained, write-once)?","type":"boolean","evidenceTypes":["config"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":20,"maxPenaltyINR":50000000},"remediationPatterns":["config","review"],"tags":["always-applies","audit"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":[],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"log","description":"Append-only, hash-chained audit ledger"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-SEC-004","title":"Conduct periodic vulnerability assessment and penetration testing","domain":"SEC","severity":"medium","obligation":"Personal-data-bearing systems should be subject to periodic vulnerability assessment and penetration testing, with findings remediated within a defined SLA.","citations":[{"instrument":"DPDPA-2023","reference":"Section 8(5)"}],"evidenceRequired":[{"type":"document","description":"Latest VAPT report + remediation evidence"}],"assessmentQuestions":[{"id":"Q1","prompt":"When was your last VAPT?","type":"text","evidenceTypes":["document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":12,"maxPenaltyINR":50000000},"remediationPatterns":["review","policy"],"tags":["always-applies"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["security_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Latest VAPT report + remediation evidence"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-SEC-005","title":"Encrypt backups of personal data","domain":"SEC","severity":"high","obligation":"Backups containing personal data must be encrypted and access-controlled at the same standard as the primary system.","citations":[{"instrument":"DPDPA-2023","reference":"Section 8(5)"}],"evidenceRequired":[{"type":"config","description":"Backup encryption configuration"}],"assessmentQuestions":[{"id":"Q1","prompt":"Are backups encrypted at rest?","type":"boolean","evidenceTypes":["config"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":15,"maxPenaltyINR":50000000},"remediationPatterns":["config"],"tags":["always-applies","ops"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["security_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"config","description":"Backup encryption configuration"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-RTN-001","title":"Define and enforce a retention schedule for personal data","domain":"RTN","severity":"high","obligation":"Personal data must be retained only for as long as necessary to satisfy the purpose for which it was collected, and erased thereafter (Section 8(7)).","citations":[{"instrument":"DPDPA-2023","reference":"Section 8(7)"}],"evidenceRequired":[{"type":"document","description":"Written retention schedule with purpose-linked durations"},{"type":"config","description":"System-level enforcement of retention + deletion"}],"assessmentQuestions":[{"id":"Q1","prompt":"Do you have a written retention schedule for each category of personal data?","type":"boolean","evidenceTypes":["document"],"dependsOn":[]},{"id":"Q2","prompt":"Is retention enforced automatically in your systems?","type":"boolean","evidenceTypes":["config"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":18,"maxPenaltyINR":50000000},"remediationPatterns":["config","policy","data-deletion"],"tags":["always-applies"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["retention_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":["retention_statement"],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Written retention schedule with purpose-linked durations"},"publicCandidateFacets":["retention_statement"],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"config","description":"System-level enforcement of retention + deletion"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-RTN-002","title":"Erase personal data upon purpose-end or withdrawal","domain":"RTN","severity":"high","obligation":"On the conclusion of the processing purpose, or on consent withdrawal, the Data Fiduciary must erase the personal data unless retention is required for legal obligation (Section 8(7)).","citations":[{"instrument":"DPDPA-2023","reference":"Section 8(7)"}],"evidenceRequired":[{"type":"log","description":"Erasure workflow + sample completed erasures"}],"assessmentQuestions":[{"id":"Q1","prompt":"Is erasure performed on the documented trigger (purpose end / withdrawal / retention expiry)?","type":"boolean","evidenceTypes":["log","config"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":18,"maxPenaltyINR":50000000},"remediationPatterns":["data-deletion","config"],"tags":["always-applies"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["correction_erasure"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"log","description":"Erasure workflow + sample completed erasures"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-RTN-003","title":"Maintain an exception register for legally-required retention","domain":"RTN","severity":"medium","obligation":"Where erasure is deferred for a legal obligation (e.g. tax, AML, litigation hold), the basis, scope, and the responsible officer must be recorded in a register that an auditor or the Board can review.","citations":[{"instrument":"DPDPA-2023","reference":"Section 8(7)"}],"evidenceRequired":[{"type":"document","description":"Exception register with reason, scope, owner, expiry"}],"assessmentQuestions":[{"id":"Q1","prompt":"Do you maintain a register of records retained for legal obligation rather than erased?","type":"boolean","evidenceTypes":["document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":8,"maxPenaltyINR":20000000},"remediationPatterns":["policy","reporting"],"tags":["always-applies"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["retention_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Exception register with reason, scope, owner, expiry"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-DPF-001","title":"Publish contact details for privacy inquiries","domain":"DPF","severity":"medium","obligation":"An email and a contact mechanism for privacy inquiries must be publicly available; this can be a grievance officer or a DPO depending on the entity's SDF status.","citations":[{"instrument":"DPDPA-2023","reference":"Section 5(3)(d), 13(1)"}],"evidenceRequired":[{"type":"screenshot","description":"Public contact details"}],"assessmentQuestions":[{"id":"Q1","prompt":"Is a privacy contact email publicly listed?","type":"boolean","evidenceTypes":["screenshot","document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":8,"maxPenaltyINR":20000000},"remediationPatterns":["policy","dpo-appointment"],"tags":["always-applies"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["privacy_contact"],"questions":[{"questionId":"Q1","publicCandidateFacets":["privacy_contact"],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"screenshot","description":"Public contact details"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-DPF-002","title":"Designate a single point of accountability for privacy","domain":"DPF","severity":"high","obligation":"Even non-SDF Data Fiduciaries benefit from designating a single internal owner — typically a Privacy Lead — who is responsible for the privacy programme, escalation, and Board reporting.","citations":[{"instrument":"DPDPA-2023","reference":"Section 8"}],"evidenceRequired":[{"type":"document","description":"Internal appointment / role description"}],"assessmentQuestions":[{"id":"Q1","prompt":"Is there a named individual accountable for the privacy programme?","type":"boolean","evidenceTypes":["document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":15,"maxPenaltyINR":50000000},"remediationPatterns":["dpo-appointment","policy"],"tags":["always-applies"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["accountability_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":["accountability_statement"],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Internal appointment / role description"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-AUD-001","title":"Maintain a continuous, timestamped evidence history of compliance","domain":"AUD","severity":"high","obligation":"A defensible compliance posture requires a continuous, timestamped, tamper-evident history of compliance evidence — not point-in-time documentation. This is the operational manifestation of the Act's \"demonstrate compliance\" burden.","citations":[{"instrument":"DPDPA-2023","reference":"Section 8, 33"}],"evidenceRequired":[{"type":"log","description":"Append-only, hash-chained evidence ledger spanning the assessment period"}],"assessmentQuestions":[{"id":"Q1","prompt":"Can you produce, on demand, a verifiable, timestamped history of every compliance control for the past 12 months?","type":"boolean","evidenceTypes":["log","document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":22,"maxPenaltyINR":50000000},"remediationPatterns":["review","reporting"],"tags":["always-applies","defensibility"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":[],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"log","description":"Append-only, hash-chained evidence ledger spanning the assessment period"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-AUD-002","title":"Report posture to the Board or Audit Committee at least annually","domain":"AUD","severity":"medium","obligation":"A periodic (at least annual) posture report to the Board or Audit Committee establishes governance accountability and provides defensible evidence of oversight.","citations":[{"instrument":"DPDPA-2023","reference":"Section 8"}],"evidenceRequired":[{"type":"document","description":"Most recent Board / Audit Committee privacy report"}],"assessmentQuestions":[{"id":"Q1","prompt":"Has the Board / Audit Committee received a privacy posture update in the past 12 months?","type":"boolean","evidenceTypes":["document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":20000000},"remediationPatterns":["reporting","policy"],"tags":["always-applies","governance"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["audit_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Most recent Board / Audit Committee privacy report"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-DPIA-001","title":"Conduct a DPIA before launching any new high-risk processing","domain":"DPIA","severity":"high","obligation":"Where processing is likely to cause harm to data principals — large-scale profiling, biometric processing, children, cross-border — a Data Protection Impact Assessment must be completed before processing begins.","citations":[{"instrument":"DPDPA-2023","reference":"Section 10"},{"instrument":"DPDPR-2025","reference":"Rule 13"}],"evidenceRequired":[{"type":"document","description":"DPIA template + completed DPIAs for high-risk processing"}],"assessmentQuestions":[{"id":"Q1","prompt":"Do you conduct a DPIA before any new high-risk processing?","type":"boolean","evidenceTypes":["document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":20,"maxPenaltyINR":50000000},"remediationPatterns":["review","policy"],"tags":["always-applies","high-risk"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["dpia_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"DPIA template + completed DPIAs for high-risk processing"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-DPIA-002","title":"Capture and remediate risks identified in the DPIA","domain":"DPIA","severity":"high","obligation":"Risks identified in a DPIA must be tracked to closure with an owner, a remediation plan, and a re-assessment after remediation.","citations":[{"instrument":"DPDPR-2025","reference":"Rule 13"}],"evidenceRequired":[{"type":"log","description":"DPIA risk register + closure evidence"}],"assessmentQuestions":[{"id":"Q1","prompt":"Are DPIA findings tracked in a risk register with owners and closure dates?","type":"boolean","evidenceTypes":["log","document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":18,"maxPenaltyINR":50000000},"remediationPatterns":["review","reporting"],"tags":["high-risk"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":[],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"log","description":"DPIA risk register + closure evidence"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-GOV-004","title":"Maintain a current org chart of data processing responsibilities","domain":"GOV","severity":"low","obligation":"Roles and responsibilities for privacy must be visible and current — who decides purposes, who signs off on processors, who handles DSARs, who is on the breach call.","citations":[{"instrument":"DPDPA-2023","reference":"Section 8"}],"evidenceRequired":[{"type":"document","description":"RACI / org chart for privacy"}],"assessmentQuestions":[{"id":"Q1","prompt":"Is there a current RACI or org chart for privacy responsibilities?","type":"boolean","evidenceTypes":["document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":5,"maxPenaltyINR":20000000},"remediationPatterns":["policy"],"tags":["governance"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["accountability_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"RACI / org chart for privacy"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-GOV-005","title":"Conduct annual privacy training for staff handling personal data","domain":"GOV","severity":"medium","obligation":"Personnel handling personal data must receive privacy training on induction and at least annually thereafter, with completion recorded.","citations":[{"instrument":"DPDPA-2023","reference":"Section 8(5)"}],"evidenceRequired":[{"type":"log","description":"Training records with completion status"}],"assessmentQuestions":[{"id":"Q1","prompt":"Do all staff handling personal data receive annual privacy training?","type":"boolean","evidenceTypes":["log"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":20000000},"remediationPatterns":["training","policy"],"tags":["always-applies","training"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":[],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"log","description":"Training records with completion status"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-BRCH-003","title":"Designate a breach response owner with a documented playbook","domain":"BRCH","severity":"high","obligation":"A named individual must own breach response end-to-end, with a documented playbook covering detection → triage → notification → post-mortem, exercised at least annually.","citations":[{"instrument":"DPDPA-2023","reference":"Section 8(6)"}],"evidenceRequired":[{"type":"document","description":"Breach response playbook"},{"type":"attestation","description":"Tabletop exercise record"}],"assessmentQuestions":[{"id":"Q1","prompt":"Is there a named breach response owner and a current playbook?","type":"boolean","evidenceTypes":["document"],"dependsOn":[]},{"id":"Q2","prompt":"Has a tabletop exercise been run in the past 12 months?","type":"boolean","evidenceTypes":["attestation"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":18,"maxPenaltyINR":50000000},"remediationPatterns":["breach-process","policy"],"tags":["always-applies"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["breach_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true},{"questionId":"Q2","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Breach response playbook"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"attestation","description":"Tabletop exercise record"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-RCD-003","title":"Map and document data flows to processors and sub-processors","domain":"RCD","severity":"high","obligation":"Beyond the RoPA, a working data-flow map (system-of-systems diagram) showing personal data movement — including to sub-processors — must be available for the Board and any DPB inquiry.","citations":[{"instrument":"DPDPR-2025","reference":"Rule 8 and Third Schedule"}],"evidenceRequired":[{"type":"inventory","description":"Data flow diagram with processors and sub-processors"}],"assessmentQuestions":[{"id":"Q1","prompt":"Is there a current data-flow map showing processors and sub-processors?","type":"boolean","evidenceTypes":["inventory","document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":18,"maxPenaltyINR":50000000},"remediationPatterns":["discovery","vendor-risk"],"tags":["always-applies"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["processor_disclosure"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"inventory","description":"Data flow diagram with processors and sub-processors"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-XBR-003","title":"Conduct a transfer impact assessment for high-risk destinations","domain":"XBR","severity":"medium","obligation":"For transfers to jurisdictions with materially different data protection regimes, a transfer impact assessment should be completed to demonstrate that the receiving environment provides comparable protection.","citations":[{"instrument":"DPDPA-2023","reference":"Section 16"}],"evidenceRequired":[{"type":"document","description":"TIA per high-risk destination"}],"assessmentQuestions":[{"id":"Q1","prompt":"Have you completed a transfer impact assessment for each cross-border destination with weaker protection?","type":"boolean","evidenceTypes":["document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":12,"maxPenaltyINR":50000000},"remediationPatterns":["vendor-risk","policy"],"tags":["cross-border"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["transfer_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"TIA per high-risk destination"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-SEC-006","title":"Securely dispose of media and devices containing personal data","domain":"SEC","severity":"medium","obligation":"Media and devices containing personal data, including at end-of-life, must be securely wiped or destroyed with a documented process and certificate of destruction where applicable.","citations":[{"instrument":"DPDPA-2023","reference":"Section 8(5)"}],"evidenceRequired":[{"type":"document","description":"Media sanitisation policy + certificate of destruction register"}],"assessmentQuestions":[{"id":"Q1","prompt":"Is there a documented media sanitisation process and a register of end-of-life destructions?","type":"boolean","evidenceTypes":["document"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":8,"maxPenaltyINR":20000000},"remediationPatterns":["policy","config"],"tags":["always-applies","ops"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["security_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Media sanitisation policy + certificate of destruction register"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-SEC-007","title":"Operate an incident response capability with rehearsed playbook","domain":"SEC","severity":"high","obligation":"Beyond breach notification, an operational incident response capability — on-call, escalation, runbook, post-mortem — is necessary to meet the 72-hour clock in practice, not just in policy.","citations":[{"instrument":"DPDPA-2023","reference":"Section 8(5), 8(6)"}],"evidenceRequired":[{"type":"document","description":"Incident response runbook + on-call roster"},{"type":"log","description":"Tabletop exercise record"}],"assessmentQuestions":[{"id":"Q1","prompt":"Do you have an on-call rotation and runbook for security incidents?","type":"boolean","evidenceTypes":["document","attestation"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":18,"maxPenaltyINR":50000000},"remediationPatterns":["breach-process","policy","training"],"tags":["always-applies"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["security_statement"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Incident response runbook + on-call roster"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true},{"index":1,"requirement":{"type":"log","description":"Tabletop exercise record"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-DAT-005","title":"Verify the identity of a data principal before acting on rights requests","domain":"DAT","severity":"medium","obligation":"Identity verification proportional to the sensitivity of the request is required before acting on access, correction, or erasure requests, to prevent unauthorised disclosure.","citations":[{"instrument":"DPDPR-2025","reference":"Rule 14"}],"evidenceRequired":[{"type":"document","description":"Identity verification procedure"}],"assessmentQuestions":[{"id":"Q1","prompt":"Do you verify the identity of the data principal before fulfilling rights requests?","type":"boolean","evidenceTypes":["document","attestation"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":20000000},"remediationPatterns":["policy","config"],"tags":["always-applies","rights"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["identity_verification"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"document","description":"Identity verification procedure"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true},{"control":{"id":"DPDPA-DAT-006","title":"Provide data portability in a structured, commonly used format","domain":"DAT","severity":"medium","obligation":"On request, the data principal is entitled to receive a copy of their personal data in a structured, commonly used and machine-readable format (Section 11(2)).","citations":[{"instrument":"DPDPA-2023","reference":"Section 11(2)"}],"evidenceRequired":[{"type":"config","description":"Export pipeline producing JSON / CSV in a documented schema"}],"assessmentQuestions":[{"id":"Q1","prompt":"Can you export a user's data in a structured, machine-readable format on request?","type":"boolean","evidenceTypes":["config","log"],"dependsOn":[]}],"scoring":{"baseline":0,"weight":1,"penaltyPoints":10,"maxPenaltyINR":20000000},"remediationPatterns":["data-portability","config"],"tags":["always-applies","rights"],"sdfOnly":false,"childrenOnly":false,"introducedInVersion":"0.1.0"},"applicability":"general","publicCandidateFacets":["portability"],"questions":[{"questionId":"Q1","publicCandidateFacets":[],"internalVerificationRequired":true}],"evidenceRequirements":[{"index":0,"requirement":{"type":"config","description":"Export pipeline producing JSON / CSV in a documented schema"},"publicCandidateFacets":[],"publicEvidenceSufficiency":"never_automatically_sufficient","internalVerificationRequired":true}],"requiresHumanReview":true}]}$manifest$::text $function$;
revoke all on function controller_security.public_control_report_mapping_manifest() from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;

create function controller_security.public_control_report_provenance(
 p_tenant_id uuid,p_run_id uuid,p_engagement_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 s public.public_control_assessment_sources;j public.assessment_dispatch_jobs;
 r public.public_control_review_sets;c public.public_website_control_evidence;
 w public.public_website_checks;p public.workload_assessment_packets;t public.workload_task_delegations;
 requested public.audit_ledger;reviewed public.audit_ledger;captured public.audit_ledger;
 snap jsonb;req jsonb;input jsonb;expected text;manifest text;provenance jsonb;
 ctrl jsonb;observed jsonb;questions jsonb;field text;declaration_value jsonb;rows_digest text;total integer;affirmed integer;denied integer;unknowns integer;answer_state text;applicability_state text;
begin
 select * into s from public.public_control_assessment_sources where run_id=p_run_id;
 if not found then return null;end if;
 if s.tenant_id is distinct from p_tenant_id or s.engagement_id is distinct from p_engagement_id
 or not public.board_assessment_source_valid(p_tenant_id,p_run_id,p_engagement_id)
 then raise exception 'human review report source refused' using errcode='23514';end if;
 select * into j from public.assessment_dispatch_jobs where id=s.job_id;
 select * into t from public.workload_task_delegations where run_id=s.run_id;
 select * into r from public.public_control_review_sets where tenant_id=p_tenant_id and id=s.review_id;
 select * into c from public.public_website_control_evidence where tenant_id=p_tenant_id and check_id=r.check_id;
 select * into w from public.public_website_checks where tenant_id=p_tenant_id and id=r.check_id;
 select * into p from public.workload_assessment_packets where tenant_id=p_tenant_id and run_id=s.run_id;
 select * into requested from public.audit_ledger where tenant_id=p_tenant_id and id=s.requested_receipt;
 select * into reviewed from public.audit_ledger where tenant_id=p_tenant_id and id=s.review_receipt;
 select * into captured from public.audit_ledger where tenant_id=p_tenant_id and id=s.capture_receipt;
 snap:=r.snapshot_text::jsonb;req:=r.request_text::jsonb;input:=s.input_text::jsonb;
 expected:=controller_security.canonical_questionnaire_json(jsonb_build_object(
  'tenant_id',p_tenant_id,'engagement_id',p_engagement_id,'library_version','0.1.1',
  'answers',snap->'normalizedAnswers','sdf_self_attested',req->'applicability'->'sdfSelfAttested',
  'processes_children',req->'applicability'->'processesChildren','processes_health',req->'applicability'->'processesHealth'));
 if j.id is null or t.run_id is null or r.id is null or c.check_id is null or w.id is null
 or j.tenant_id is distinct from p_tenant_id or j.actor_id is distinct from s.actor_id
 or j.run_id is distinct from s.run_id or j.engagement_id is distinct from p_engagement_id
 or j.estate_id is distinct from s.estate_id or j.input_hash is distinct from s.input_sha256
 or t.tenant_id is distinct from p_tenant_id or t.created_by is distinct from s.actor_id
 or t.engagement_id is distinct from p_engagement_id or t.estate_id is distinct from s.estate_id
 or t.input_hash is distinct from s.input_sha256 or t.correlation_id is distinct from j.correlation_id
 or r.engagement_id is distinct from p_engagement_id or r.estate_id is distinct from s.estate_id
 or r.request_sha256 is distinct from s.request_sha256 or r.snapshot_sha256 is distinct from s.snapshot_sha256
 or r.receipt_id is distinct from s.review_receipt or c.capture_receipt is distinct from s.capture_receipt
 or s.input_text is distinct from expected
 or s.input_sha256 is distinct from encode(sha256(convert_to(s.input_text,'UTF8')),'hex')
 or r.request_sha256 is distinct from encode(sha256(convert_to(r.request_text,'UTF8')),'hex')
 or r.snapshot_sha256 is distinct from encode(sha256(convert_to(r.snapshot_text,'UTF8')),'hex')
 or snap->'request' is distinct from req or snap->>'tenantId' is distinct from p_tenant_id::text
 or snap->>'engagementId' is distinct from p_engagement_id::text or (snap->>'estateId')::uuid is distinct from s.estate_id
 or snap->>'checkId' is distinct from r.check_id::text or snap->>'captureReceipt' is distinct from c.capture_receipt::text
 or (snap->>'checkedAt')::timestamptz is distinct from w.checked_at
 or snap->'declarationsVerified' is distinct from 'false'::jsonb or snap->'requiresHumanReview' is distinct from 'true'::jsonb
 or req->'expectedSource'->>'payloadSha256' is distinct from c.payload_sha256
 or req->'expectedSource'->>'libraryVersion' is distinct from '0.1.1'
 or req->'expectedSource'->>'mappingVersion' is distinct from 'public-evidence-1'
 or req->'expectedSource'->>'questionnaireDigest' is distinct from '1fcd03e3c5e1cbec9bf09f86a0f26d05ec117d4d4acb3a8a448195e5ee897b0e'
 or c.codec is distinct from 'axiom-public-evidence-v2-canonical-json-1'
 or c.payload_sha256 is distinct from encode(sha256(convert_to(c.payload_text,'UTF8')),'hex')
 or requested.id is null or requested.action_type::text is distinct from 'assessment.requested'
 or requested.actor_type::text is distinct from 'human' or requested.actor_id is distinct from s.actor_id::text
 or requested.correlation_id is distinct from s.job_id or requested.target_ref is distinct from s.job_id::text
 or requested.input_hash is distinct from s.input_sha256 or requested.result::text is distinct from 'pending'
 or requested.detail->>'run_id' is distinct from s.run_id::text
 or reviewed.id is null or reviewed.action_type::text is distinct from 'public_control.review_recorded'
 or reviewed.actor_type::text is distinct from 'human' or reviewed.actor_id is distinct from r.actor_id::text
 or reviewed.correlation_id is distinct from r.operation_key or reviewed.target_ref is distinct from r.id::text
 or reviewed.input_hash is distinct from r.request_sha256 or reviewed.output_hash is distinct from r.snapshot_sha256
 or reviewed.result::text is distinct from 'success'
 or captured.id is null or captured.action_type::text is distinct from 'connector.website.evidence_captured'
 or captured.actor_type::text is distinct from 'human' or captured.actor_id is distinct from w.actor_id::text
 or captured.correlation_id is distinct from w.correlation_id or w.status is distinct from 'checked'
 or captured.target_ref is distinct from w.id::text or captured.input_hash is distinct from c.payload_sha256
 or captured.output_hash is distinct from encode(sha256(convert_to(c.page_sources::text,'UTF8')),'hex')
 or captured.result::text is distinct from 'success'
 then raise exception 'human review report binding refused' using errcode='23514';end if;
 -- The normal worker already emits these declarations. A report may not imply
 -- they came from this review unless the finalized packet agrees exactly.
 select encode(sha256(convert_to(controller_security.canonical_questionnaire_json(jsonb_agg(v-'created_at' order by v->>'id')),'UTF8')),'hex') into rows_digest from jsonb_array_elements(p.controls)v;
 if rows_digest is distinct from 'ddf7b3202e731871a78012ddeffa7b8ebde4c2f4b8b3dbbfa7fd95e1c6a7a011'
 then raise exception 'human review frozen catalogue refused' using errcode='23514';end if;
 provenance:=p.result->'questionnaire_provenance';
 if p.library_version is distinct from '0.1.1' or provenance->>'source_library_version' is distinct from p.library_version
 or provenance->>'source_library_digest' is distinct from p.library_digest
 or provenance->'version' is distinct from '1'::jsonb or provenance->>'estimates' is distinct from 'provisional'
 or provenance->'review_required' is distinct from 'true'::jsonb
 or jsonb_typeof(provenance->'controls') is distinct from 'array'
 or jsonb_array_length(provenance->'controls') is distinct from jsonb_array_length(p.controls)
 then raise exception 'human review computation provenance refused' using errcode='23514';end if;
 for ctrl in select value from jsonb_array_elements(p.controls) loop
  select value into observed from jsonb_array_elements(provenance->'controls') where value->>'control_id'=ctrl->>'id';
  select coalesce(jsonb_agg(jsonb_build_object('question_id',value->>'id','declaration',case input->'answers'->(ctrl->>'id')->(value->>'id') when 'true'::jsonb then 'caller_affirmed' when 'false'::jsonb then 'caller_denied' else 'unknown' end) order by value->>'id'),'[]'::jsonb)
   into questions from jsonb_array_elements(ctrl->'assessment_questions') where value->>'type'='boolean';
  select count(*),count(*) filter(where value->>'declaration'='caller_affirmed'),count(*) filter(where value->>'declaration'='caller_denied'),count(*) filter(where value->>'declaration'='unknown') into total,affirmed,denied,unknowns from jsonb_array_elements(questions);
  answer_state:=case when total=0 then 'not_boolean_assessable' when unknowns=total then 'unknown' when unknowns>0 then 'partially_answered' else 'caller_declared_unverified' end;
  applicability_state:=case when ctrl->>'sdf_only'<>'true' and ctrl->>'children_only'<>'true' then 'unconditional' when (ctrl->>'sdf_only'='true' and input->'sdf_self_attested'='false'::jsonb) or (ctrl->>'children_only'='true' and input->'processes_children'='false'::jsonb) then 'caller_declared_not_applicable_unverified' when (ctrl->>'sdf_only'='true' and input->'sdf_self_attested'='null'::jsonb) or (ctrl->>'children_only'='true' and input->'processes_children'='null'::jsonb) then 'unknown' else 'caller_declared_applicable_unverified' end;
  if observed is null or observed->'questions' is distinct from questions
   or observed->'known_boolean_question_count' is distinct from to_jsonb(total) or observed->'caller_affirmed_count' is distinct from to_jsonb(affirmed) or observed->'caller_denied_count' is distinct from to_jsonb(denied) or observed->'unknown_count' is distinct from to_jsonb(unknowns)
   or observed->>'answer_state' is distinct from answer_state or observed->>'applicability_state' is distinct from applicability_state
   or (select count(*) from jsonb_array_elements(provenance->'controls') where value->>'control_id'=ctrl->>'id')<>1
  then raise exception 'human review answer provenance refused' using errcode='23514';end if;
 end loop;
 foreach field in array array['sdf_self_attested','processes_children','processes_health'] loop
  declaration_value:=input->field;
  if provenance->'applicability'->field is distinct from jsonb_build_object('value',declaration_value,'provenance',case when declaration_value='null'::jsonb then 'unknown' else 'caller_declared_unverified' end)
  then raise exception 'human review applicability provenance refused' using errcode='23514';end if;
 end loop;
 manifest:=controller_security.public_control_report_mapping_manifest();
 if req->'expectedSource'->>'catalogueManifestSha256' is distinct from encode(sha256(convert_to(manifest,'UTF8')),'hex')
 then raise exception 'human review mapping provenance refused' using errcode='23514';end if;
 return jsonb_build_object(
  'schema_version',1,'kind','public_control_review','tenant_id',p_tenant_id,'engagement_id',p_engagement_id,'estate_id',s.estate_id,
  'job_id',s.job_id,'assessment_run_id',s.run_id,'requested_by',s.actor_id,
  'worker_input',jsonb_build_object('codec','axiom-assessment-input-canonical-json-1','text',s.input_text,'sha256',s.input_sha256),
  'requested_receipt',jsonb_build_object('id',requested.id::text,'entry_hash',requested.entry_hash),
  'review',jsonb_build_object('id',r.id,'actor_id',r.actor_id,'operation_key',r.operation_key,'request_codec',r.request_codec,'request_text',r.request_text,'request_sha256',r.request_sha256,'snapshot_codec',r.snapshot_codec,'snapshot_text',r.snapshot_text,'snapshot_sha256',r.snapshot_sha256,'receipt',jsonb_build_object('id',reviewed.id::text,'entry_hash',reviewed.entry_hash),'created_at',r.created_at),
  'capture',jsonb_build_object('check_id',c.check_id,'checked_at',w.checked_at,'codec',c.codec,'payload_text',c.payload_text,'payload_sha256',c.payload_sha256,'page_sources',c.page_sources,'page_sources_text',c.page_sources::text,'page_sources_sha256',captured.output_hash,'capture_receipt',jsonb_build_object('id',captured.id::text,'entry_hash',captured.entry_hash)),
  'catalogue',jsonb_build_object('library_version','0.1.1','questionnaire_digest',req->'expectedSource'->'questionnaireDigest','mapping_version','public-evidence-1','manifest_text',manifest,'manifest_sha256',encode(sha256(convert_to(manifest,'UTF8')),'hex')),
  'declarations_verified',false,'evidence_verified',false,'review_required',true
 );
end $$;
revoke all on function controller_security.public_control_report_provenance(uuid,uuid,uuid) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;

-- Legacy source construction is unchanged; only linked runs use source v2.
create or replace function public.capture_board_request_source() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  packet public.workload_assessment_packets;
  started public.audit_ledger;
  completed public.audit_ledger;
  finalized public.audit_ledger;
  controls_text text;
  result_text text;
  source_text text;
  human_review jsonb;
begin
  -- The request RPC checked and share-locked the same finalized packet.
  -- Recheck here so an alternative privileged INSERT cannot freeze a
  -- merely completed or mismatched packet.
  if not public.board_assessment_source_valid(
    new.tenant_id, new.assessment_run_id, new.engagement_id
  ) then
    raise exception 'board assessment source is not finalized';
  end if;

  select * into packet from public.workload_assessment_packets
    where tenant_id = new.tenant_id and run_id = new.assessment_run_id
      and engagement_id = new.engagement_id for share;
  if not found or packet.result_digest is distinct from new.assessment_result_digest
     or packet.library_digest is distinct from new.library_digest
     or packet.library_version is distinct from new.library_version then
    raise exception 'board assessment source changed';
  end if;

  controls_text := packet.controls::text;
  result_text := packet.result::text;
  if packet.library_digest is distinct from encode(sha256(convert_to(controls_text, 'UTF8')), 'hex')
     or packet.result_digest is distinct from encode(sha256(convert_to(result_text, 'UTF8')), 'hex') then
    raise exception 'board assessment digest mismatch';
  end if;

  select * into started from public.audit_ledger
    where tenant_id = new.tenant_id and id = packet.started_receipt;
  select * into completed from public.audit_ledger
    where tenant_id = new.tenant_id and id = packet.completed_receipt;
  select * into finalized from public.audit_ledger
    where tenant_id = new.tenant_id and id = packet.finalized_receipt;

  source_text := jsonb_build_object(
    'schema_version', 1,
    'serialization', 'postgres-jsonb-text-v1',
    'kind', 'board_source',
    'request_id', new.id,
    'tenant_id', new.tenant_id,
    'engagement_id', new.engagement_id,
    'assessment_run_id', new.assessment_run_id,
    'library_version', packet.library_version,
    'controls_text', controls_text,
    'controls_sha256', packet.library_digest,
    'result_text', result_text,
    'result_sha256', packet.result_digest,
    'completed_at', packet.completed_at,
    'finalized_at', packet.finalized_at,
    'receipts', jsonb_build_object(
      'started', jsonb_build_object('id', started.id::text, 'entry_hash', started.entry_hash),
      'completed', jsonb_build_object('id', completed.id::text, 'entry_hash', completed.entry_hash),
      'finalized', jsonb_build_object('id', finalized.id::text, 'entry_hash', finalized.entry_hash)
    ),
    'limitations', jsonb_build_array(
      'Recorded questionnaire computation; no independent evidence verification.',
      'Current remediation state is not included.',
      'Not a compliance certification or legal opinion.'
    )
  )::text;
  human_review := controller_security.public_control_report_provenance(new.tenant_id,new.assessment_run_id,new.engagement_id);
  if human_review is not null then
    source_text := (source_text::jsonb || jsonb_build_object('schema_version',2,'human_control_review',human_review))::text;
  end if;
  if octet_length(source_text) > 4194304 then
    raise exception 'board source exceeds byte limit';
  end if;

  insert into public.board_request_sources (
    request_id, tenant_id, source_text, source_sha256,
    controls_sha256, result_sha256
  ) values (
    new.id, new.tenant_id, source_text,
    encode(sha256(convert_to(source_text, 'UTF8')), 'hex'),
    packet.library_digest, packet.result_digest
  );
  return new;
end $$;

-- Legacy source construction is unchanged; only linked runs use source v2.
create or replace function public.capture_statutory_request_source() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  packet public.workload_assessment_packets;
  started public.audit_ledger;
  completed public.audit_ledger;
  finalized public.audit_ledger;
  controls_text text;
  result_text text;
  source_text text;
  human_review jsonb;
begin
  -- The request RPC checked and share-locked the same finalized packet.
  -- Recheck here so an alternative privileged INSERT cannot freeze a
  -- merely completed or mismatched packet.
  if not public.board_assessment_source_valid(
    new.tenant_id, new.assessment_run_id, new.engagement_id
  ) then
    raise exception 'auditor assessment source is not finalized';
  end if;

  select * into packet from public.workload_assessment_packets
    where tenant_id = new.tenant_id and run_id = new.assessment_run_id
      and engagement_id = new.engagement_id for share;
  if not found or packet.result_digest is distinct from new.assessment_result_digest
     or packet.library_digest is distinct from new.library_digest
     or packet.library_version is distinct from new.library_version then
    raise exception 'auditor assessment source changed';
  end if;

  controls_text := packet.controls::text;
  result_text := packet.result::text;
  if packet.library_digest is distinct from encode(sha256(convert_to(controls_text, 'UTF8')), 'hex')
     or packet.result_digest is distinct from encode(sha256(convert_to(result_text, 'UTF8')), 'hex') then
    raise exception 'auditor assessment digest mismatch';
  end if;

  select * into started from public.audit_ledger
    where tenant_id = new.tenant_id and id = packet.started_receipt;
  select * into completed from public.audit_ledger
    where tenant_id = new.tenant_id and id = packet.completed_receipt;
  select * into finalized from public.audit_ledger
    where tenant_id = new.tenant_id and id = packet.finalized_receipt;

  source_text := jsonb_build_object(
    'schema_version', 1,
    'serialization', 'postgres-jsonb-text-v1',
    'kind', 'statutory_source',
    'report_kind', new.kind,
    'request_id', new.id,
    'tenant_id', new.tenant_id,
    'engagement_id', new.engagement_id,
    'assessment_run_id', new.assessment_run_id,
    'library_version', packet.library_version,
    'controls_text', controls_text,
    'controls_sha256', packet.library_digest,
    'result_text', result_text,
    'result_sha256', packet.result_digest,
    'completed_at', packet.completed_at,
    'finalized_at', packet.finalized_at,
    'receipts', jsonb_build_object(
      'started', jsonb_build_object('id', started.id::text, 'entry_hash', started.entry_hash),
      'completed', jsonb_build_object('id', completed.id::text, 'entry_hash', completed.entry_hash),
      'finalized', jsonb_build_object('id', finalized.id::text, 'entry_hash', finalized.entry_hash)
    ),
    'limitations', jsonb_build_array(
      'Recorded questionnaire computation; no independent evidence verification.',
      'Current remediation state is not included.',
      'Assessment-derived auditor review only; no independent audit attestation, evidence certification, compliance certification or legal opinion.'
    )
  )::text;
  human_review := controller_security.public_control_report_provenance(new.tenant_id,new.assessment_run_id,new.engagement_id);
  if human_review is not null then
    source_text := (source_text::jsonb || jsonb_build_object('schema_version',2,'human_control_review',human_review))::text;
  end if;
  if octet_length(source_text) > 4194304 then
    raise exception 'auditor source exceeds byte limit';
  end if;

  insert into public.statutory_request_sources (
    request_id, tenant_id, source_text, source_sha256,
    controls_sha256, result_sha256
  ) values (
    new.id, new.tenant_id, source_text,
    encode(sha256(convert_to(source_text, 'UTF8')), 'hex'),
    packet.library_digest, packet.result_digest
  );
  return new;
end $$;

-- This pure projection mirrors the report-kit appendix. No caller may supply
-- arbitrary public evidence or relabel omitted judgments as human-reviewed.
create function controller_security.public_control_report_appendix(h jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare req jsonb:=(h->'review'->>'request_text')::jsonb;snap jsonb:=(h->'review'->>'snapshot_text')::jsonb;
 payload jsonb:=(h->'capture'->>'payload_text')::jsonb;m jsonb:=(h->'catalogue'->>'manifest_text')::jsonb;
 rows jsonb:='[]';row jsonb;q jsonb;j jsonb;allowed jsonb;qs jsonb;rs jsonb;candidates jsonb;available jsonb;e jsonb;
begin
 for row in select value from jsonb_array_elements(m->'controls') loop
  qs:='[]';rs:='[]';
  for q in select value from jsonb_array_elements(row->'control'->'assessmentQuestions') loop
   j:=req->'answers'->(row->'control'->>'id')->(q->>'id');
   select value->'publicCandidateFacets' into allowed from jsonb_array_elements(row->'questions') where value->>'questionId'=q->>'id';
   select coalesce(jsonb_agg(c.value order by ord),'[]') into candidates from jsonb_array_elements(coalesce(j->'candidateOrdinals','[]')) with ordinality x(value,ord) join lateral (select value from jsonb_array_elements(payload->'candidates') where value->'ordinal'=x.value)c on true;
   select coalesce(jsonb_agg(value->'ordinal' order by ord),'[]') into available from jsonb_array_elements(payload->'candidates') with ordinality x(value,ord) where allowed?(value->>'facet');
   qs:=qs||jsonb_build_array(jsonb_build_object('questionId',q->'id','prompt',q->'prompt','type',q->'type','judgment',case when j is null then 'omitted' else 'explicit' end,'answer',case when q->>'type'='boolean' then snap->'normalizedAnswers'->(row->'control'->>'id')->(q->>'id') else 'null'::jsonb end,'rationale',j->'rationale','candidates',candidates,'availableCandidateOrdinals',available));
  end loop;
  for e in select value from jsonb_array_elements(row->'evidenceRequirements') loop
   select coalesce(jsonb_agg(value->'ordinal' order by ord),'[]') into available from jsonb_array_elements(payload->'candidates') with ordinality x(value,ord) where (e->'publicCandidateFacets')?(value->>'facet');
   rs:=rs||jsonb_build_array(jsonb_build_object('index',e->'index','requirement',e->'requirement','state','internal_verification_required','availableCandidateOrdinals',available));
  end loop;
  rows:=rows||jsonb_build_array(jsonb_build_object('controlId',row->'control'->'id','title',row->'control'->'title','questions',qs,'evidenceRequirements',rs));
 end loop;
 return jsonb_build_object('version',1,'reviewId',h->'review'->'id','reviewActorId',h->'review'->'actor_id','reviewedAt',h->'review'->'created_at','requestedBy',h->'requested_by','jobId',h->'job_id','assessmentRunId',h->'assessment_run_id','estateId',h->'estate_id',
 'reviewRequestSha256',h->'review'->'request_sha256','reviewSnapshotSha256',h->'review'->'snapshot_sha256','capturePayloadSha256',h->'capture'->'payload_sha256','captureCheckedAt',h->'capture'->'checked_at','captureReceipt',h->'capture'->'capture_receipt','reviewReceipt',h->'review'->'receipt','requestedReceipt',h->'requested_receipt',
 'captureAssessmentDate',to_char((h->'capture'->>'checked_at')::timestamptz at time zone 'UTC','YYYY-MM-DD'),
 'catalogue',jsonb_build_object('baseline',m->'provenance'->'baseline','defaultEffectiveFrom',m->'provenance'->'defaultEffectiveFrom','perControlEffectiveDates',m->'provenance'->'perControlEffectiveDates','effectiveStatus',m->'provenance'->'effectiveStatus','library_version',h->'catalogue'->'library_version','questionnaire_digest',h->'catalogue'->'questionnaire_digest','mapping_version',h->'catalogue'->'mapping_version','manifest_sha256',h->'catalogue'->'manifest_sha256'),
 'pages',payload->'pages','pageSources',h->'capture'->'page_sources','candidatesTruncated',payload->'candidatesTruncated','publicCandidates',payload->'candidates','applicability',req->'applicability','controls',rows,'declarationsVerified',false,'evidenceVerified',false,'requiresHumanReview',true);
end $$;
revoke all on function controller_security.public_control_report_appendix(jsonb) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;

create function controller_security.public_control_report_interpretation(result jsonb,title text) returns jsonb
language plpgsql immutable set search_path='' as $$
declare f jsonb;p jsonb;state text;band text;findings jsonb:='[]';summary jsonb;
begin
 for f in select value from jsonb_array_elements(result->'findings') loop
  select value into p from jsonb_array_elements(result->'questionnaire_provenance'->'controls') where value->>'control_id'=f->>'control_id';
  state:=case when p->>'applicability_state'='caller_declared_not_applicable_unverified' then 'declared_not_applicable_unverified' when p->>'applicability_state'='unknown' or p->>'answer_state' in ('unknown','partially_answered') then 'unknown' when p->>'answer_state'='not_boolean_assessable' then 'not_boolean_assessable' else 'provisional_score_band' end;
  band:=case when state<>'provisional_score_band' then null when (f->>'score')::numeric>=80 then 'at_least_80' when (f->>'score')::numeric>=40 then 'from_40_to_under_80' else 'under_40' end;
  findings:=findings||jsonb_build_array(jsonb_build_object('control_id',f->'control_id','display_state',state,'answer_state',p->'answer_state','applicability_state',p->'applicability_state','answer_counts',jsonb_build_object('known',p->'known_boolean_question_count','affirmed',p->'caller_affirmed_count','denied',p->'caller_denied_count','unknown',p->'unknown_count'),'score_band',band));
 end loop;
 select jsonb_build_object('posture_score',result->'posture_score','total_controls',jsonb_array_length(findings),
 'provisional_score_bands',jsonb_build_object('at_least_80',count(*) filter(where value->>'score_band'='at_least_80'),'from_40_to_under_80',count(*) filter(where value->>'score_band'='from_40_to_under_80'),'under_40',count(*) filter(where value->>'score_band'='under_40')),
 'unknown_controls',count(*) filter(where value->>'display_state'='unknown'),'not_applicable_controls',count(*) filter(where value->>'display_state'='declared_not_applicable_unverified'),'not_boolean_assessable_controls',count(*) filter(where value->>'display_state'='not_boolean_assessable'),'provenance_unavailable_controls',0,
 'estimated_exposure_inr',result->'estimated_exposure_inr','narrative','This report summarizes the recorded assessment for '||title||'. The computed posture score is '||trim_scale((result->>'posture_score')::numeric)::text||'%. Scores and exposure are provisional computation estimates requiring evidence and human/legal review. Questionnaire declarations and applicability remain unverified; unavailable provenance cannot establish answers or applicability.') into summary from jsonb_array_elements(findings);
 return jsonb_build_object('interpretation',jsonb_build_object('version',1,'provenance','caller_declared_unverified','estimates','provisional','review_required',true),'summary',summary,'findings',findings);
end $$;
revoke all on function controller_security.public_control_report_interpretation(jsonb,text) from public,anon,authenticated,service_role,human_action_writer,agent_ledger_writer,axiom_assessment_controller;

create or replace function public.record_board_report_draft(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_request_id uuid,
  p_content_text text,
  p_html_text text,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_req public.board_report_requests;
  v_report public.reports;
  v_content jsonb;
  v_content_hash text;
  v_html_hash text;
  v_source public.board_request_sources;
  expected_review jsonb;
begin
  if not public.report_founder_allowed(p_tenant_id, p_actor_id) then
    return jsonb_build_object('error', 'founder_authority_required');
  end if;

  if p_request_id is null or p_correlation_id is null or p_content_text is null
     or octet_length(p_content_text) > 5242880 or p_html_text is null
     or octet_length(p_html_text) > 5242880 then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  begin
    v_content := p_content_text::jsonb;
  exception when invalid_text_representation then
    return jsonb_build_object('error', 'invalid_request');
  end;

  if jsonb_typeof(v_content) is distinct from 'object' then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  select * into v_req from public.board_report_requests
   where tenant_id = p_tenant_id and id = p_request_id;

  if not found then
    return jsonb_build_object('error', 'request_not_found');
  end if;

  if not public.board_assessment_source_valid(p_tenant_id, v_req.assessment_run_id, v_req.engagement_id) then
    return jsonb_build_object('error', 'assessment_not_finalized');
  end if;

  select * into v_req from public.board_report_requests
   where tenant_id = p_tenant_id and id = p_request_id for update;
  if not found then
    return jsonb_build_object('error', 'request_not_found');
  end if;

  select * into v_source from public.board_request_sources where tenant_id=p_tenant_id and request_id=v_req.id;
  if v_source.source_text::jsonb->>'schema_version'='2' then
    expected_review:=controller_security.public_control_report_interpretation((v_source.source_text::jsonb->>'result_text')::jsonb,v_req.title);
    if v_content->'schema_version' is distinct from '3'::jsonb
     or v_content->>'kind' is distinct from 'board_report' or v_content->>'title' is distinct from v_req.title
     or v_content->>'tenant_id' is distinct from p_tenant_id::text or v_content->>'engagement_id' is distinct from v_req.engagement_id::text
     or v_content->>'assessment_run_id' is distinct from v_req.assessment_run_id::text
     or v_content->>'source_sha256' is distinct from v_source.source_sha256
     or v_content->>'assessment_result_digest' is distinct from v_req.assessment_result_digest
     or v_content->>'library_version' is distinct from v_req.library_version or v_content->>'library_digest' is distinct from v_req.library_digest
     or v_content->'public_review_appendix' is distinct from controller_security.public_control_report_appendix(v_source.source_text::jsonb->'human_control_review')
     or v_content->'questionnaire_interpretation' is distinct from expected_review->'interpretation'
     or v_content->'executive_summary' is distinct from expected_review->'summary'
    then return jsonb_build_object('error','assessment_source_conflict');end if;
  elsif v_content->'schema_version'='3'::jsonb or v_content?'public_review_appendix' then
    return jsonb_build_object('error','assessment_source_conflict');
  end if;
  if v_req.status not in ('requested', 'drafted') then
    return jsonb_build_object('error', 'invalid_request_state');
  end if;

  v_content_hash := encode(sha256(convert_to(p_content_text, 'UTF8')), 'hex');
  v_html_hash := encode(sha256(convert_to(p_html_text, 'UTF8')), 'hex');

  if v_req.report_id is not null then
    select * into v_report from public.reports
     where tenant_id = p_tenant_id and id = v_req.report_id for update;
    if found and v_report.content_sha256 = v_content_hash then
      return jsonb_build_object(
        'reportId', v_report.id,
        'requestId', v_req.id,
        'status', v_report.status,
        'contentHash', v_content_hash,
        'replayed', true
      );
    end if;
  end if;

  insert into public.reports (
    tenant_id, engagement_id, kind, title, storage_uri, content,
    library_version, generated_by_agent, operation_key, created_by,
    content_text, content_sha256
  ) values (
    p_tenant_id, v_req.engagement_id, 'board'::public.report_kind, v_req.title, null, v_content,
    v_req.library_version, 'board-report-builder', v_req.operation_key, p_actor_id,
    p_content_text, v_content_hash
  ) returning * into v_report;

  insert into public.board_report_artifacts (
    tenant_id, report_id, source_json_sha256, source_json_bytes,
    html_sha256, html_bytes
  ) values (
    p_tenant_id, v_report.id, v_content_hash, octet_length(p_content_text),
    v_html_hash, octet_length(p_html_text)
  );

  update public.board_report_requests
     set report_id = v_report.id,
         status = 'drafted',
         updated_at = clock_timestamp()
   where tenant_id = p_tenant_id and id = v_req.id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'system', 'board-report-builder', null, null, null,
    'report.drafted'::public.ledger_action_type, v_report.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'request_id', v_req.id,
      'content_hash', v_content_hash,
      'html_hash', v_html_hash
    )
  );

  return jsonb_build_object(
    'reportId', v_report.id,
    'requestId', v_req.id,
    'status', 'draft',
    'contentHash', v_content_hash,
    'replayed', false
  );
end $$;

create or replace function public.record_source_bound_statutory_draft(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_request_id uuid,
  p_content_text text,
  p_html_text text,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = '' as $$
declare
  v_req public.statutory_report_requests;
  v_report public.reports;
  v_source public.statutory_request_sources;
  v_content jsonb;
  v_result jsonb;
  v_source_document jsonb;
  v_controls jsonb;
  v_content_hash text;
  v_html_hash text;
  extra_fields text[];
begin
  if not public.report_founder_allowed(p_tenant_id, p_actor_id) then
    return jsonb_build_object('error', 'founder_authority_required');
  end if;

  if p_request_id is null or p_correlation_id is null or p_content_text is null
     or octet_length(p_content_text) > 5242880 or p_html_text is null
     or octet_length(p_html_text) > 5242880 then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  begin
    v_content := p_content_text::jsonb;
  exception when invalid_text_representation then
    return jsonb_build_object('error', 'invalid_request');
  end;

  if jsonb_typeof(v_content) is distinct from 'object' then
    return jsonb_build_object('error', 'invalid_request');
  end if;

  select * into v_req from public.statutory_report_requests
   where tenant_id = p_tenant_id and id = p_request_id;

  if not found then
    return jsonb_build_object('error', 'request_not_found');
  end if;

  if not public.board_assessment_source_valid(p_tenant_id, v_req.assessment_run_id, v_req.engagement_id) then
    return jsonb_build_object('error', 'assessment_not_finalized');
  end if;

  select * into v_req from public.statutory_report_requests
   where tenant_id = p_tenant_id and id = p_request_id for update;
  if not found then
    return jsonb_build_object('error', 'request_not_found');
  end if;

  select * into v_source from public.statutory_request_sources
   where tenant_id = p_tenant_id and request_id = v_req.id;
  if found then
    v_source_document := v_source.source_text::jsonb;
    v_result := (v_source_document->>'result_text')::jsonb;
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',item->>'id','title',item->>'title','domain',item->>'domain','severity',item->>'severity'
    ) order by ordinal),'[]'::jsonb) into v_controls
    from jsonb_array_elements((v_source_document->>'controls_text')::jsonb) with ordinality as c(item,ordinal);
  end if;
  extra_fields:=case when v_source_document->>'schema_version'='2' then array['public_review_appendix','questionnaire_review'] else array[]::text[] end;
  if not found or v_source.source_sha256 is distinct from encode(sha256(convert_to(v_source.source_text,'UTF8')),'hex')
    or not (v_content ?& (array['schema_version','kind','source_kind','request_id','tenant_id',
      'engagement_id','assessment_run_id','source_sha256','assessment_result_digest','library_digest',
      'library_version','title','generated_by','generated_at','posture_score','finalized_at',
      'finalized_ledger_receipt','findings','controls','limitations']||extra_fields))
    or (v_content - (array['schema_version','kind','source_kind','request_id','tenant_id',
      'engagement_id','assessment_run_id','source_sha256','assessment_result_digest','library_digest',
      'library_version','title','generated_by','generated_at','posture_score','finalized_at',
      'finalized_ledger_receipt','findings','controls','limitations']||extra_fields)) <> '{}'::jsonb
    or v_content->'schema_version' is distinct from (case when v_source_document->>'schema_version'='2' then '3'::jsonb else '2'::jsonb end)
    or (v_source_document->>'schema_version'='2' and (v_content->'public_review_appendix' is distinct from controller_security.public_control_report_appendix(v_source_document->'human_control_review') or v_content->'questionnaire_review' is distinct from controller_security.public_control_report_interpretation(v_result,v_req.title)))
    or v_content->>'kind' is distinct from 'auditor_pack'
    or v_content->>'source_kind' is distinct from 'finalized_assessment'
    or v_content->>'request_id' is distinct from v_req.id::text
    or v_content->>'tenant_id' is distinct from p_tenant_id::text
    or v_content->>'engagement_id' is distinct from v_req.engagement_id::text
    or v_content->>'source_sha256' is distinct from v_source.source_sha256
    or v_content->>'assessment_run_id' is distinct from v_req.assessment_run_id::text
    or v_content->>'assessment_result_digest' is distinct from v_req.assessment_result_digest
    or v_content->>'library_digest' is distinct from v_req.library_digest
    or v_content->>'library_version' is distinct from v_req.library_version
    or v_content->>'title' is distinct from v_req.title
    or v_content->>'generated_by' is distinct from 'statutory-report-builder'
    or jsonb_typeof(v_content->'generated_at') is distinct from 'string'
    or length(coalesce(v_content->>'generated_at','')) not between 1 and 80
    or v_content->'posture_score' is distinct from v_result->'posture_score'
    or v_content->>'finalized_at' is distinct from v_source_document->>'finalized_at'
    or v_content->>'finalized_ledger_receipt' is distinct from v_source_document#>>'{receipts,finalized,id}'
    or jsonb_typeof(v_result->'findings') is distinct from 'array'
    or v_content->'findings' is distinct from v_result->'findings'
    or v_content->'controls' is distinct from v_controls
    or v_content->>'limitations' is distinct from
      'Assessment-derived findings only. No independent audit, evidence verification, or auditor attestation is represented.' then
    return jsonb_build_object('error', 'assessment_source_conflict');
  end if;

  if v_req.status not in ('requested', 'drafted') then
    return jsonb_build_object('error', 'invalid_request_state');
  end if;

  v_content_hash := encode(sha256(convert_to(p_content_text, 'UTF8')), 'hex');
  v_html_hash := encode(sha256(convert_to(p_html_text, 'UTF8')), 'hex');

  if v_req.report_id is not null then
    select * into v_report from public.reports
     where tenant_id = p_tenant_id and id = v_req.report_id for update;
    if found then
      if v_report.content_sha256 is distinct from v_content_hash then
        return jsonb_build_object('error','idempotency_conflict');
      end if;
      return jsonb_build_object(
        'reportId', v_report.id,
        'requestId', v_req.id,
        'status', v_report.status,
        'contentHash', v_content_hash,
        'replayed', true
      );
    end if;
  end if;

  insert into public.reports (
    tenant_id, engagement_id, kind, title, storage_uri, content,
    library_version, generated_by_agent, operation_key, created_by,
    content_text, content_sha256
  ) values (
    p_tenant_id, v_req.engagement_id, v_req.kind, v_req.title, null, v_content,
    v_req.library_version, 'statutory-report-builder', v_req.operation_key, p_actor_id,
    p_content_text, v_content_hash
  ) returning * into v_report;

  insert into public.statutory_report_artifacts (
    tenant_id, report_id, kind, source_json_sha256, source_json_bytes,
    html_sha256, html_bytes
  ) values (
    p_tenant_id, v_report.id, v_req.kind, v_content_hash, octet_length(p_content_text),
    v_html_hash, octet_length(p_html_text)
  );

  update public.statutory_report_requests
     set report_id = v_report.id,
         status = 'drafted',
         updated_at = clock_timestamp()
   where tenant_id = p_tenant_id and id = v_req.id;

  perform public.append_ledger(
    p_tenant_id, p_correlation_id, 'system', 'statutory-report-builder', null, null, null,
    'report.drafted'::public.ledger_action_type, v_report.id::text,
    null, null, null, null, null, null, 'success',
    jsonb_build_object(
      'request_id', v_req.id,
      'content_hash', v_content_hash,
      'html_hash', v_html_hash
    )
  );

  return jsonb_build_object(
    'reportId', v_report.id,
    'requestId', v_req.id,
    'status', 'draft',
    'contentHash', v_content_hash,
    'replayed', false
  );
end $$;
