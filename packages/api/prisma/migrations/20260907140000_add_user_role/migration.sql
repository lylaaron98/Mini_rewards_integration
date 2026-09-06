-- Roles.
--
-- NOT NULL DEFAULT USER, so existing rows and any future insert that forgets
-- the column are unprivileged. A nullable role would make "no role" a third
-- state every check has to handle, and the safe reading of an unset privilege
-- is always the one that grants nothing.
--
-- Nothing in the application grants ADMIN. Promoting an account is a
-- deliberate act against the database, not something an endpoint offers —
-- a self-service route to privilege is the shape of most privilege-escalation
-- bugs.

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'USER';

