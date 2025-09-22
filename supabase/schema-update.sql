

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "moddatetime" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."add_regex_flags"("p_pattern" "text", "p_flags" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select case
           when coalesce(p_flags,'') = '' then p_pattern
           else '(?' || p_flags || ')' || p_pattern
         end
$$;


ALTER FUNCTION "public"."add_regex_flags"("p_pattern" "text", "p_flags" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."auto_categorize_tx"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_cat  text; v_src text; v_mkey text; v_mname text;
begin
  -- NEW: respect manual on INSERT too
  if new.category_source = 'manual' then
    return new;
  end if;

  -- If this row was previously manual, do nothing on UPDATE (manual wins)
  if tg_op = 'UPDATE' and old.category_source = 'manual' then
    return new;
  end if;

  select out_category, out_source, out_merchant_key, out_merchant_name
    into v_cat, v_src, v_mkey, v_mname
  from public.pick_category_for_tx(new.user_id, new.bank_account_id, new.description);

  new.category        := v_cat;
  new.category_source := 'auto';
  new.merchant_key    := v_mkey;
  new.merchant_name   := v_mname;
  return new;
end $$;


ALTER FUNCTION "public"."auto_categorize_tx"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."clear_transaction_manual_category"("p_tx" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user uuid; v_bank uuid; v_desc text;
  v_cat  text; v_src text; v_mkey text; v_mname text;
begin
  select user_id, bank_account_id, description
    into v_user, v_bank, v_desc
  from public.transactions
  where id = p_tx and user_id = auth.uid();

  if not found then
    return;
  end if;

  select out_category, out_source, out_merchant_key, out_merchant_name
    into v_cat, v_src, v_mkey, v_mname
  from public.pick_category_for_tx(v_user, v_bank, v_desc);

  update public.transactions
     set category = v_cat,
         category_source = 'auto',
         merchant_key = v_mkey,
         merchant_name = v_mname
   where id = p_tx and user_id = auth.uid();
end $$;


ALTER FUNCTION "public"."clear_transaction_manual_category"("p_tx" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (new.id, new.raw_user_meta_data ->> 'display_name');
  RETURN new;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."keep_manual_category"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.category_source = 'auto' AND OLD.category_source = 'manual' THEN
    NEW.category := OLD.category;
    NEW.category_source := 'manual';
  END IF;
  RETURN NEW;
END; $$;


ALTER FUNCTION "public"."keep_manual_category"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_merchant_for_tx"("p_desc" "text", "p_bank_account_id" "uuid") RETURNS TABLE("merchant_key" "text", "merchant_name" "text")
    LANGUAGE "plpgsql"
    AS $$
declare
  v_bank_name text;
  v_country   text;
begin
  -- Resolve bank & country for this account
  select cb.bank_name, cb.country
    into v_bank_name, v_country
  from public.bank_accounts ba
  join public.connected_banks cb on cb.id = ba.connected_bank_id
  where ba.id = p_bank_account_id;

  return query
  select mp.merchant_key,
         ma.display_name
  from public.merchant_patterns mp
  left join public.merchant_aliases ma on ma.merchant_key = mp.merchant_key
  where mp.is_enabled
    and (mp.bank    is null or mp.bank    = v_bank_name)
    and (mp.country is null or mp.country = v_country)
    and (p_desc ~ public.add_regex_flags(mp.pattern, mp.flags))
  order by mp.priority asc, mp.created_at asc
  limit 1;
end $$;


ALTER FUNCTION "public"."match_merchant_for_tx"("p_desc" "text", "p_bank_account_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pick_category_for_tx"("p_user_id" "uuid", "p_bank_account_id" "uuid", "p_desc" "text") RETURNS TABLE("out_category" "text", "out_source" "text", "out_merchant_key" "text", "out_merchant_name" "text")
    LANGUAGE "plpgsql"
    AS $$
declare
  v_mkey text;
  v_mname text;
  v_bank_name text;
  v_country   text;
begin
  -- Try merchant-based flow
  select m.merchant_key, m.merchant_name
    into v_mkey, v_mname
  from public.match_merchant_for_tx(p_desc, p_bank_account_id) m;

  if v_mkey is not null then
    -- 4a) Per-user override?
    select uco.category into out_category
    from public.user_category_overrides uco
    where uco.user_id = p_user_id and uco.merchant_key = v_mkey;

    if out_category is not null then
      out_source := 'user_override';
      out_merchant_key := v_mkey; out_merchant_name := v_mname;
      return;
    end if;

    -- 4b) Merchant default?
    select ma.default_category into out_category
    from public.merchant_aliases ma
    where ma.merchant_key = v_mkey;

    if out_category is not null then
      out_source := 'merchant_default';
      out_merchant_key := v_mkey; out_merchant_name := coalesce(v_mname, (select display_name from public.merchant_aliases where merchant_key=v_mkey));
      return;
    end if;
  end if;

  -- 4c) Global fallback rules (bank & country aware)
  select cb.bank_name, cb.country
    into v_bank_name, v_country
  from public.bank_accounts ba
  join public.connected_banks cb on cb.id = ba.connected_bank_id
  where ba.id = p_bank_account_id;

  select cr.category into out_category
  from public.category_rules cr
  where cr.is_enabled
    and (cr.bank    is null or cr.bank    = v_bank_name)
    and (cr.country is null or cr.country = v_country)
    and (p_desc ~ public.add_regex_flags(cr.pattern, cr.flags))
  order by cr.priority asc, cr.created_at asc
  limit 1;

  if out_category is not null then
    out_source := 'rule';
    return;
  end if;

  -- 4d) Final fallback
  out_category := 'Other';
  out_source   := 'fallback';
  return;
end $$;


ALTER FUNCTION "public"."pick_category_for_tx"("p_user_id" "uuid", "p_bank_account_id" "uuid", "p_desc" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_transaction_category"("p_tx" "uuid", "p_category" "text") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  update public.transactions
     set category = p_category,
         category_source = 'manual'
   where id = p_tx and user_id = auth.uid();
$$;


ALTER FUNCTION "public"."set_transaction_category"("p_tx" "uuid", "p_category" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
    -- Explicitly set an empty search path to prevent schema-related security risks
    SET search_path = '';
    
    -- Rest of your existing function logic
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_category_rule"("p_pattern" "text", "p_category" "text", "p_flags" "text" DEFAULT 'i'::"text", "p_priority" integer DEFAULT 100, "p_bank" "text" DEFAULT NULL::"text", "p_country" "text" DEFAULT NULL::"text", "p_is_enabled" boolean DEFAULT true) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_id uuid;
begin
  insert into public.category_rules(pattern, flags, category, bank, country, priority, is_enabled)
  values (p_pattern, p_flags, p_category, p_bank, p_country, p_priority, p_is_enabled)
  returning id into v_id;

  return v_id;
end $$;


ALTER FUNCTION "public"."upsert_category_rule"("p_pattern" "text", "p_category" "text", "p_flags" "text", "p_priority" integer, "p_bank" "text", "p_country" "text", "p_is_enabled" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_user_category_override"("p_merchant_key" "text", "p_category" "text") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  insert into public.user_category_overrides(user_id, merchant_key, category)
  values (auth.uid(), p_merchant_key, p_category)
  on conflict (user_id, merchant_key)
  do update set category = excluded.category;
$$;


ALTER FUNCTION "public"."upsert_user_category_override"("p_merchant_key" "text", "p_category" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."account_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."account_groups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bank_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "connected_bank_id" "uuid" NOT NULL,
    "provider" "text" DEFAULT 'gocardless'::"text" NOT NULL,
    "institution_id" "text" NOT NULL,
    "account_id" "text" NOT NULL,
    "name" "text",
    "iban" "text",
    "currency" "text",
    "type" "text",
    "is_selected" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_sync_at" timestamp with time zone,
    "next_allowed_sync_at" timestamp with time zone,
    "last_sync_status" "text"
);


ALTER TABLE "public"."bank_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."budgets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "category" "text" NOT NULL,
    "monthly_limit" numeric(10,2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."budgets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."category_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pattern" "text" NOT NULL,
    "flags" "text" DEFAULT 'i'::"text" NOT NULL,
    "category" "text" NOT NULL,
    "bank" "text",
    "country" "text",
    "priority" integer DEFAULT 100 NOT NULL,
    "is_enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."category_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."connected_banks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "bank_name" "text" NOT NULL,
    "account_id" "text" NOT NULL,
    "institution_id" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "connected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "provider" "text" DEFAULT 'gocardless'::"text" NOT NULL,
    "link_id" "text",
    "country" "text" DEFAULT 'SE'::"text",
    "consent_expires_at" timestamp with time zone,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reference" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."connected_banks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."group_memberships" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "group_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" DEFAULT 'member'::"text" NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "group_memberships_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'admin'::"text", 'member'::"text"])))
);


ALTER TABLE "public"."group_memberships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."merchant_aliases" (
    "merchant_key" "text" NOT NULL,
    "display_name" "text",
    "default_category" "text",
    "country" "text"
);


ALTER TABLE "public"."merchant_aliases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."merchant_patterns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pattern" "text" NOT NULL,
    "flags" "text" DEFAULT 'i'::"text" NOT NULL,
    "merchant_key" "text" NOT NULL,
    "bank" "text",
    "country" "text",
    "priority" integer DEFAULT 100 NOT NULL,
    "is_enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."merchant_patterns" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "display_name" "text",
    "avatar_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "bank_account_id" "uuid" NOT NULL,
    "transaction_id" "text" NOT NULL,
    "description" "text" NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "category" "text" DEFAULT 'Other'::"text" NOT NULL,
    "date" "date" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "category_source" "text" DEFAULT 'auto'::"text" NOT NULL,
    "merchant_key" "text",
    "merchant_name" "text"
);


ALTER TABLE "public"."transactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_category_overrides" (
    "user_id" "uuid" NOT NULL,
    "merchant_key" "text" NOT NULL,
    "category" "text" NOT NULL
);


ALTER TABLE "public"."user_category_overrides" OWNER TO "postgres";


ALTER TABLE ONLY "public"."account_groups"
    ADD CONSTRAINT "account_groups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_unique_provider_acct" UNIQUE ("user_id", "provider", "account_id");



ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_user_id_category_key" UNIQUE ("user_id", "category");



ALTER TABLE ONLY "public"."category_rules"
    ADD CONSTRAINT "category_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."connected_banks"
    ADD CONSTRAINT "connected_banks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."connected_banks"
    ADD CONSTRAINT "connected_banks_user_id_account_id_key" UNIQUE ("user_id", "account_id");



ALTER TABLE ONLY "public"."group_memberships"
    ADD CONSTRAINT "group_memberships_group_id_user_id_key" UNIQUE ("group_id", "user_id");



ALTER TABLE ONLY "public"."group_memberships"
    ADD CONSTRAINT "group_memberships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."merchant_aliases"
    ADD CONSTRAINT "merchant_aliases_pkey" PRIMARY KEY ("merchant_key");



ALTER TABLE ONLY "public"."merchant_patterns"
    ADD CONSTRAINT "merchant_patterns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_unique_per_account" UNIQUE ("user_id", "bank_account_id", "transaction_id");



ALTER TABLE ONLY "public"."user_category_overrides"
    ADD CONSTRAINT "user_category_overrides_pkey" PRIMARY KEY ("user_id", "merchant_key");



CREATE INDEX "bank_accounts_connected_bank_id_idx" ON "public"."bank_accounts" USING "btree" ("connected_bank_id");



CREATE INDEX "bank_accounts_next_allowed_sync_at_idx" ON "public"."bank_accounts" USING "btree" ("next_allowed_sync_at");



CREATE INDEX "bank_accounts_user_id_idx" ON "public"."bank_accounts" USING "btree" ("user_id");



CREATE INDEX "idx_category_rules_bank" ON "public"."category_rules" USING "btree" ("bank");



CREATE INDEX "idx_category_rules_country" ON "public"."category_rules" USING "btree" ("country");



CREATE INDEX "idx_category_rules_prio" ON "public"."category_rules" USING "btree" ("priority");



CREATE INDEX "idx_cb_status_expiry" ON "public"."connected_banks" USING "btree" ("status", "consent_expires_at");



CREATE INDEX "idx_connected_banks_link" ON "public"."connected_banks" USING "btree" ("link_id");



CREATE INDEX "idx_connected_banks_user" ON "public"."connected_banks" USING "btree" ("user_id");



CREATE UNIQUE INDEX "idx_merchant_patterns_key" ON "public"."merchant_patterns" USING "btree" ("merchant_key", "pattern", "flags");



CREATE INDEX "idx_tx_desc_trgm" ON "public"."transactions" USING "gin" ("lower"("description") "extensions"."gin_trgm_ops");



CREATE INDEX "idx_tx_merchant_key" ON "public"."transactions" USING "btree" ("merchant_key");



CREATE INDEX "idx_tx_user_bank_date" ON "public"."transactions" USING "btree" ("user_id", "bank_account_id", "date" DESC);



CREATE INDEX "transactions_account_date_idx" ON "public"."transactions" USING "btree" ("bank_account_id", "date" DESC);



CREATE INDEX "transactions_user_date_idx" ON "public"."transactions" USING "btree" ("user_id", "date" DESC);



CREATE OR REPLACE TRIGGER "set_connected_banks_updated_at" BEFORE UPDATE ON "public"."connected_banks" FOR EACH ROW EXECUTE FUNCTION "extensions"."moddatetime"('updated_at');



CREATE OR REPLACE TRIGGER "trg_auto_categorize_tx" BEFORE INSERT OR UPDATE OF "description" ON "public"."transactions" FOR EACH ROW EXECUTE FUNCTION "public"."auto_categorize_tx"();



CREATE OR REPLACE TRIGGER "trg_keep_manual_category" BEFORE UPDATE ON "public"."transactions" FOR EACH ROW EXECUTE FUNCTION "public"."keep_manual_category"();



CREATE OR REPLACE TRIGGER "update_account_groups_updated_at" BEFORE UPDATE ON "public"."account_groups" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_budgets_updated_at" BEFORE UPDATE ON "public"."budgets" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



ALTER TABLE ONLY "public"."account_groups"
    ADD CONSTRAINT "account_groups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_connected_bank_id_fkey" FOREIGN KEY ("connected_bank_id") REFERENCES "public"."connected_banks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."budgets"
    ADD CONSTRAINT "budgets_user_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."connected_banks"
    ADD CONSTRAINT "connected_banks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."group_memberships"
    ADD CONSTRAINT "group_memberships_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."account_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."group_memberships"
    ADD CONSTRAINT "group_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_bank_account_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_user_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."user_category_overrides"
    ADD CONSTRAINT "user_category_overrides_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "Group admins can manage memberships" ON "public"."group_memberships" USING ((EXISTS ( SELECT 1
   FROM "public"."group_memberships" "gm"
  WHERE (("gm"."group_id" = "group_memberships"."group_id") AND ("gm"."user_id" = "auth"."uid"()) AND ("gm"."role" = ANY (ARRAY['owner'::"text", 'admin'::"text"]))))));



CREATE POLICY "Group owners can update their groups" ON "public"."account_groups" FOR UPDATE USING (("created_by" = "auth"."uid"()));



CREATE POLICY "Users can create account groups" ON "public"."account_groups" FOR INSERT WITH CHECK (("created_by" = "auth"."uid"()));



CREATE POLICY "Users can create their own budgets" ON "public"."budgets" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can create their own transactions" ON "public"."transactions" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete own profile" ON "public"."profiles" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can delete their own budgets" ON "public"."budgets" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete their own transactions" ON "public"."transactions" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert their own profile" ON "public"."profiles" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "Users can manage their own connected banks" ON "public"."connected_banks" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update their own budgets" ON "public"."budgets" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update their own profile" ON "public"."profiles" FOR UPDATE USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "Users can update their own transactions" ON "public"."transactions" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view groups they belong to" ON "public"."account_groups" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."group_memberships"
  WHERE (("group_memberships"."group_id" = "account_groups"."id") AND ("group_memberships"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can view memberships in their groups" ON "public"."group_memberships" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."group_memberships" "gm"
  WHERE (("gm"."group_id" = "group_memberships"."group_id") AND ("gm"."user_id" = "auth"."uid"()) AND ("gm"."role" = ANY (ARRAY['owner'::"text", 'admin'::"text"])))))));



CREATE POLICY "Users can view own profile" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can view their own budgets" ON "public"."budgets" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own connected banks" ON "public"."connected_banks" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own profile" ON "public"."profiles" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."account_groups" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ba_insert_own" ON "public"."bank_accounts" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."bank_accounts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bank_accounts_select_own" ON "public"."bank_accounts" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "bank_accounts_update_own" ON "public"."bank_accounts" FOR UPDATE USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."budgets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."category_rules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cb_insert_own" ON "public"."connected_banks" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "cb_select_own" ON "public"."connected_banks" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "cb_update_own" ON "public"."connected_banks" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."connected_banks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cr_select_all" ON "public"."category_rules" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."group_memberships" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ma_select_all" ON "public"."merchant_aliases" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."merchant_aliases" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."merchant_patterns" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "mp_select_all" ON "public"."merchant_patterns" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."transactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tx_insert_own" ON "public"."transactions" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "tx_select_own" ON "public"."transactions" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "tx_update_own" ON "public"."transactions" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "uco_delete_own" ON "public"."user_category_overrides" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "uco_select_own" ON "public"."user_category_overrides" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "uco_update_own" ON "public"."user_category_overrides" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "uco_upsert_own" ON "public"."user_category_overrides" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."user_category_overrides" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

























































































































































































































































GRANT ALL ON FUNCTION "public"."add_regex_flags"("p_pattern" "text", "p_flags" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."add_regex_flags"("p_pattern" "text", "p_flags" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."add_regex_flags"("p_pattern" "text", "p_flags" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."auto_categorize_tx"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auto_categorize_tx"() TO "service_role";



GRANT ALL ON FUNCTION "public"."clear_transaction_manual_category"("p_tx" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."clear_transaction_manual_category"("p_tx" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."keep_manual_category"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."keep_manual_category"() TO "service_role";



GRANT ALL ON FUNCTION "public"."match_merchant_for_tx"("p_desc" "text", "p_bank_account_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_merchant_for_tx"("p_desc" "text", "p_bank_account_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."pick_category_for_tx"("p_user_id" "uuid", "p_bank_account_id" "uuid", "p_desc" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pick_category_for_tx"("p_user_id" "uuid", "p_bank_account_id" "uuid", "p_desc" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_transaction_category"("p_tx" "uuid", "p_category" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_transaction_category"("p_tx" "uuid", "p_category" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";



GRANT ALL ON FUNCTION "public"."upsert_category_rule"("p_pattern" "text", "p_category" "text", "p_flags" "text", "p_priority" integer, "p_bank" "text", "p_country" "text", "p_is_enabled" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."upsert_user_category_override"("p_merchant_key" "text", "p_category" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_user_category_override"("p_merchant_key" "text", "p_category" "text") TO "service_role";


















GRANT ALL ON TABLE "public"."account_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."account_groups" TO "service_role";



GRANT ALL ON TABLE "public"."bank_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."budgets" TO "authenticated";
GRANT ALL ON TABLE "public"."budgets" TO "service_role";



GRANT ALL ON TABLE "public"."category_rules" TO "service_role";
GRANT SELECT ON TABLE "public"."category_rules" TO "authenticated";



GRANT ALL ON TABLE "public"."connected_banks" TO "authenticated";
GRANT ALL ON TABLE "public"."connected_banks" TO "service_role";



GRANT ALL ON TABLE "public"."group_memberships" TO "authenticated";
GRANT ALL ON TABLE "public"."group_memberships" TO "service_role";



GRANT ALL ON TABLE "public"."merchant_aliases" TO "service_role";
GRANT SELECT ON TABLE "public"."merchant_aliases" TO "authenticated";



GRANT ALL ON TABLE "public"."merchant_patterns" TO "service_role";
GRANT SELECT ON TABLE "public"."merchant_patterns" TO "authenticated";



GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."transactions" TO "service_role";



GRANT ALL ON TABLE "public"."user_category_overrides" TO "authenticated";
GRANT ALL ON TABLE "public"."user_category_overrides" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";






























RESET ALL;
