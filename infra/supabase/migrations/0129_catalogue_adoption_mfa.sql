-- Source-only dedicated human step-up purpose. No publisher membership, grants,
-- credentials, mutation route, catalogue publication or adoption is activated.
alter type public.mfa_challenge_purpose add value if not exists 'catalogue_adoption';
