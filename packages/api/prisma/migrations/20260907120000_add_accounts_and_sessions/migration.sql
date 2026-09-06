-- Accounts and sessions.
--
-- email becomes UNIQUE because it is now the login identifier. It stays
-- nullable: a user can exist without ever having signed in — an operator
-- import, or a partner reference we were told about before the person
-- registered — and Postgres allows many NULLs under a unique index, so those
-- coexist while every real account stays distinct.
--
-- password_hash is nullable for the same reason. An account without one cannot
-- be logged into, and the login route treats that identically to a wrong
-- password, so the form cannot be used to discover which accounts exist.
--
-- sessions.id holds the SHA-256 of the token, never the token. The cookie
-- carries 32 random bytes; a dump of this table therefore yields nothing an
-- attacker can present as a session. A session token is a bearer credential and
-- gets the same treatment as a password.
--
-- ON DELETE CASCADE, unlike every ledger foreign key: a session is not a record
-- of anything worth keeping once its user is gone.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "password_hash" TEXT;

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

