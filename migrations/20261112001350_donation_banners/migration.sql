-- CreateTable
CREATE TABLE "DonationBanner" (
    "slot" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "DonationBanner_pkey" PRIMARY KEY ("slot")
);
