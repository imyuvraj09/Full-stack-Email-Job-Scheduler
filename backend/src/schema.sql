CREATE TABLE IF NOT EXISTS account (
    id text PRIMARY KEY,
    name text NOT NULL,
    email text NOT NULL,
    avatar text,
    slack text
);

CREATE TABLE IF NOT EXISTS session (
    id text PRIMARY KEY,
    owner text REFERENCES account,
    expires timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign (
    id uuid PRIMARY KEY,
    owner text NOT NULL REFERENCES account,
    request_key uuid NOT NULL,
    digest text NOT NULL,
    sender text NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    gap int NOT NULL,
    cap int NOT NULL,
    UNIQUE (owner, request_key)
);
CREATE INDEX IF NOT EXISTS campaign_owner ON campaign (owner);

CREATE TABLE IF NOT EXISTS email (
    id uuid PRIMARY KEY,
    campaign uuid NOT NULL REFERENCES campaign,
    recipient text NOT NULL,
    due timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'scheduled',
    started timestamptz,
    finished timestamptz,
    detail text,
    preview text,
    revision bigint NOT NULL DEFAULT 1,
    UNIQUE (campaign, recipient)
);
CREATE INDEX IF NOT EXISTS email_campaign ON email (campaign, due);

CREATE TABLE IF NOT EXISTS throttle (
    key text PRIMARY KEY,
    window_id bigint NOT NULL,
    used int NOT NULL,
    next_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS event (
    id bigserial PRIMARY KEY,
    kind text NOT NULL,
    entity text NOT NULL,
    available timestamptz DEFAULT now(),
    attempts int DEFAULT 0
);
CREATE INDEX IF NOT EXISTS event_ready ON event (kind, available, id);
