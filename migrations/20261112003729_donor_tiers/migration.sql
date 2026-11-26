-- CreateTable
CREATE TABLE "DonationTier" (
    "roleId" TEXT NOT NULL,
    "minCents" INTEGER NOT NULL,

    CONSTRAINT "DonationTier_pkey" PRIMARY KEY ("roleId")
);
