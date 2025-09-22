

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






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






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
    "category_source" "text" DEFAULT 'auto'::"text" NOT NULL
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
    ADD CONSTRAINT "budgets_category_key" UNIQUE ("category");



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



CREATE INDEX "idx_profiles_user_id" ON "public"."profiles" USING "btree" ("id");



CREATE INDEX "idx_tx_user_bank_date" ON "public"."transactions" USING "btree" ("user_id", "bank_account_id", "date" DESC);



CREATE INDEX "idx_tx_user_date" ON "public"."transactions" USING "btree" ("user_id", "date" DESC);



CREATE INDEX "transactions_account_date_idx" ON "public"."transactions" USING "btree" ("bank_account_id", "date" DESC);



CREATE INDEX "transactions_user_date_idx" ON "public"."transactions" USING "btree" ("user_id", "date" DESC);



CREATE OR REPLACE TRIGGER "set_connected_banks_updated_at" BEFORE UPDATE ON "public"."connected_banks" FOR EACH ROW EXECUTE FUNCTION "extensions"."moddatetime"('updated_at');



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



CREATE POLICY "Users can create own profile" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "id"));



CREATE POLICY "Users can create their own budgets" ON "public"."budgets" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can create their own transactions" ON "public"."transactions" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete own profile" ON "public"."profiles" FOR DELETE TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "id"));



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



CREATE POLICY "Users can view own profile" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "id"));



CREATE POLICY "Users can view their own budgets" ON "public"."budgets" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own connected banks" ON "public"."connected_banks" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own profile" ON "public"."profiles" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."account_groups" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ba_insert_own" ON "public"."bank_accounts" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."bank_accounts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bank_accounts_select_own" ON "public"."bank_accounts" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "bank_accounts_update_own" ON "public"."bank_accounts" FOR UPDATE USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."budgets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cb_insert_own" ON "public"."connected_banks" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "cb_select_own" ON "public"."connected_banks" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "cb_update_own" ON "public"."connected_banks" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."connected_banks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."group_memberships" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."transactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tx_insert_own" ON "public"."transactions" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "tx_select_own" ON "public"."transactions" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "tx_update_own" ON "public"."transactions" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "update_own_bank_accounts" ON "public"."bank_accounts" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";




























































































































































GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."keep_manual_category"() TO "anon";
GRANT ALL ON FUNCTION "public"."keep_manual_category"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."keep_manual_category"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";


















GRANT ALL ON TABLE "public"."account_groups" TO "anon";
GRANT ALL ON TABLE "public"."account_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."account_groups" TO "service_role";



GRANT ALL ON TABLE "public"."bank_accounts" TO "anon";
GRANT ALL ON TABLE "public"."bank_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."budgets" TO "anon";
GRANT ALL ON TABLE "public"."budgets" TO "authenticated";
GRANT ALL ON TABLE "public"."budgets" TO "service_role";



GRANT ALL ON TABLE "public"."category_rules" TO "anon";
GRANT ALL ON TABLE "public"."category_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."category_rules" TO "service_role";



GRANT ALL ON TABLE "public"."connected_banks" TO "anon";
GRANT ALL ON TABLE "public"."connected_banks" TO "authenticated";
GRANT ALL ON TABLE "public"."connected_banks" TO "service_role";



GRANT ALL ON TABLE "public"."group_memberships" TO "anon";
GRANT ALL ON TABLE "public"."group_memberships" TO "authenticated";
GRANT ALL ON TABLE "public"."group_memberships" TO "service_role";



GRANT ALL ON TABLE "public"."merchant_aliases" TO "anon";
GRANT ALL ON TABLE "public"."merchant_aliases" TO "authenticated";
GRANT ALL ON TABLE "public"."merchant_aliases" TO "service_role";



GRANT ALL ON TABLE "public"."merchant_patterns" TO "anon";
GRANT ALL ON TABLE "public"."merchant_patterns" TO "authenticated";
GRANT ALL ON TABLE "public"."merchant_patterns" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."transactions" TO "service_role";



GRANT ALL ON TABLE "public"."user_category_overrides" TO "anon";
GRANT ALL ON TABLE "public"."user_category_overrides" TO "authenticated";
GRANT ALL ON TABLE "public"."user_category_overrides" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";






























RESET ALL;
