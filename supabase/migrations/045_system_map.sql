-- 045_system_map.sql (IA master variant)
-- Wiki-style living documentation of the BCC. Pages are categorized
-- (overview / domain / schema / integration / automation / decision /
-- runbook / glossary), keyed by slug, and updated_at-touched on every write.
-- Content changes (body_md/title/category/related_slugs) auto-snapshot to
-- system_map_revisions for an audit trail. Pure verified-bumps via
-- bump_system_map_verified do NOT create a revision row.
--
-- Companions: 046_system_map_staleness_check.sql (drift RPC),
-- 047_current_system_overview.sql (session-start overview RPC).
-- The pg_cron schedule that calls 046 lives in a follow-up commit
-- (alongside pg_cron extension enablement).
--
-- IA-MASTER ADAPTATION FROM JAY'S SOURCE:
--   * Stripped the bottom module-registration block. IA master has no
--     module registry table; modules are registered via the hard-coded
--     NAV array in src/BCCApp.jsx instead.


-- 1) Tables ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.system_map (
  slug              text         PRIMARY KEY,
  title             text         NOT NULL,
  category          text         NOT NULL,
  body_md           text         NOT NULL,
  related_slugs     text[]       NOT NULL DEFAULT ARRAY[]::text[],
  sort_order        integer      NOT NULL DEFAULT 100,
  source_of_truth   text         NOT NULL DEFAULT 'manual',
  last_verified_at  timestamptz,
  last_verified_by  text,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT system_map_category_check
    CHECK (category = ANY (ARRAY[
      'overview','domain','schema','integration',
      'automation','decision','runbook','glossary'
    ])),
  CONSTRAINT system_map_source_of_truth_check
    CHECK (source_of_truth = ANY (ARRAY['manual','auto']))
);

CREATE TABLE IF NOT EXISTS public.system_map_revisions (
  id              bigserial     PRIMARY KEY,
  slug            text          NOT NULL,
  title           text          NOT NULL,
  category        text          NOT NULL,
  body_md         text          NOT NULL,
  related_slugs   text[]        NOT NULL DEFAULT ARRAY[]::text[],
  edited_by       text,
  edited_at       timestamptz   NOT NULL DEFAULT now(),
  reason          text
);


-- 2) Indexes -----------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_system_map_category
  ON public.system_map USING btree (category, sort_order);

CREATE INDEX IF NOT EXISTS idx_system_map_search
  ON public.system_map USING gin
     (to_tsvector('english'::regconfig, (title || ' ' || body_md)));

CREATE INDEX IF NOT EXISTS idx_system_map_revisions_slug
  ON public.system_map_revisions USING btree (slug, edited_at DESC);


-- 3) Trigger functions -------------------------------------------------------

-- Touch updated_at on every write.
CREATE OR REPLACE FUNCTION public.tg_system_map_touch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Snapshot the pre-update row to system_map_revisions whenever real content
-- (body_md/title/category/related_slugs) changes. Verified-bumps that only
-- touch last_verified_at do NOT trigger this — by design.
CREATE OR REPLACE FUNCTION public.tg_system_map_revise()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.body_md          IS DISTINCT FROM NEW.body_md
     OR OLD.title         IS DISTINCT FROM NEW.title
     OR OLD.category      IS DISTINCT FROM NEW.category
     OR OLD.related_slugs IS DISTINCT FROM NEW.related_slugs
  THEN
    INSERT INTO public.system_map_revisions
      (slug, title, category, body_md, related_slugs, edited_by, reason)
    VALUES
      (OLD.slug, OLD.title, OLD.category, OLD.body_md,
       OLD.related_slugs, OLD.last_verified_by, 'pre-update snapshot');
  END IF;
  RETURN NEW;
END;
$$;


-- 4) Triggers ----------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_system_map_touch ON public.system_map;
CREATE TRIGGER trg_system_map_touch
  BEFORE UPDATE ON public.system_map
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_system_map_touch();

DROP TRIGGER IF EXISTS trg_system_map_revise ON public.system_map;
CREATE TRIGGER trg_system_map_revise
  BEFORE UPDATE ON public.system_map
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_system_map_revise();


-- 5) RPC: bump_system_map_verified -------------------------------------------
-- Records a "Verified now" review without producing a revision row. Used by
-- the webapp Verified-now button and by session-start mandatory query #1
-- when Claude re-confirms a page that drifted past the staleness threshold.

CREATE OR REPLACE FUNCTION public.bump_system_map_verified(
  p_slug         text,
  p_verified_by  text DEFAULT NULL
)
RETURNS public.system_map
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.system_map;
BEGIN
  UPDATE public.system_map
     SET last_verified_at = now(),
         last_verified_by = COALESCE(p_verified_by, last_verified_by)
   WHERE slug = p_slug
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'system_map slug not found: %', p_slug;
  END IF;

  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.bump_system_map_verified(text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.bump_system_map_verified(text, text) TO authenticated, service_role;

-- (Module registration block omitted — see IA-MASTER ADAPTATION header note.)
