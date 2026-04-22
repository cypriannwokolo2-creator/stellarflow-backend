import { Keypair } from "@stellar/stellar-sdk";
import dotenv from "dotenv";
import prisma from "../lib/prisma";
import { assertSigningAllowed } from "../state/appState";

dotenv.config();

export interface SignatureRequest {
  multiSigPriceId: number;
  currency: string;
  rate: number;
  source: string;
  memoId: string;
  requiredSignatures: number;
}

export interface SignaturePayload {
  multiSigPriceId: number;
  currency: string;
  rate: number;
  source: string;
  memoId: string;
  signerPublicKey: string;
}

type RemoteSignatureResponse = {
  success?: boolean;
  error?: string;
  data?: {
    multiSigPriceId?: number;
    signature?: string;
    signerPublicKey?: string;
    signerName?: string;
  };
};

export class MultiSigService {
  private readonly localSignerPublicKey: string;
  private readonly localSignerSecret: string;
  private readonly signerName: string;
  private readonly SIGNATURE_EXPIRY_MS = 60 * 60 * 1000;
  private readonly REQUIRED_SIGNATURES: number;

  constructor() {
    const secret =
      process.env.ORACLE_SECRET_KEY || process.env.SOROBAN_ADMIN_SECRET;
    if (!secret) {
      throw new Error(
        "ORACLE_SECRET_KEY or SOROBAN_ADMIN_SECRET not found in environment variables",
      );
    }

    this.localSignerSecret = secret;
    this.localSignerPublicKey = Keypair.fromSecret(secret).publicKey();
    this.signerName = process.env.ORACLE_SIGNER_NAME || "oracle-server";

    const requiredSignatures = Number.parseInt(
      process.env.MULTI_SIG_REQUIRED_COUNT || "2",
      10,
    );
    this.REQUIRED_SIGNATURES =
      Number.isFinite(requiredSignatures) && requiredSignatures > 0
        ? requiredSignatures
        : 2;
  }

  async createMultiSigRequest(
    priceReviewId: number,
    currency: string,
    rate: number,
    source: string,
    memoId: string,
  ): Promise<SignatureRequest> {
    const expiresAt = new Date(Date.now() + this.SIGNATURE_EXPIRY_MS);

    const created = await prisma.multiSigPrice.create({
      data: {
        priceReviewId,
        currency,
        rate,
        source,
        memoId,
        status: "PENDING",
        requiredSignatures: this.REQUIRED_SIGNATURES,
        collectedSignatures: 0,
        expiresAt,
      },
    });

    console.info(
      `[MultiSig] Created signature request ${created.id} for ${currency} rate ${rate}`,
    );

    return {
      multiSigPriceId: created.id,
      currency,
      rate,
      source,
      memoId,
      requiredSignatures: this.REQUIRED_SIGNATURES,
    };
  }

  async signMultiSigPrice(
    multiSigPriceId: number,
  ): Promise<{ signature: string; signerPublicKey: string }> {
    const multiSigPrice = await prisma.multiSigPrice.findUnique({
      where: { id: multiSigPriceId },
    });

    if (!multiSigPrice) {
      throw new Error(`MultiSigPrice ${multiSigPriceId} not found`);
    }

    if (multiSigPrice.status !== "PENDING") {
      throw new Error(
        `Cannot sign MultiSigPrice ${multiSigPriceId} - status is ${multiSigPrice.status}`,
      );
    }

    if (new Date() > multiSigPrice.expiresAt) {
      await prisma.multiSigPrice.update({
        where: { id: multiSigPriceId },
        data: { status: "EXPIRED" },
      });
      throw new Error(`MultiSigPrice ${multiSigPriceId} has expired`);
    }

    await assertSigningAllowed();

    const signatureMessage = this.createSignatureMessage(
      multiSigPrice.currency,
      multiSigPrice.rate.toString(),
      multiSigPrice.source,
    );
    const signature = Keypair.fromSecret(this.localSignerSecret)
      .sign(Buffer.from(signatureMessage, "utf-8"))
      .toString("hex");

    let createdSignature = true;

    try {
      await prisma.multiSigSignature.create({
        data: {
          multiSigPriceId,
          signerPublicKey: this.localSignerPublicKey,
          signerName: this.signerName,
          signature,
        },
      });
    } catch (error: any) {
      if (error?.code !== "P2002") {
        throw error;
      }

      createdSignature = false;
    }

    if (createdSignature) {
      const updated = await prisma.multiSigPrice.update({
        where: { id: multiSigPriceId },
        data: {
          collectedSignatures: {
            increment: 1,
          },
        },
      });

      console.info(
        `[MultiSig] Added signature ${updated.collectedSignatures}/${updated.requiredSignatures} for MultiSigPrice ${multiSigPriceId}`,
      );

      if (updated.collectedSignatures >= updated.requiredSignatures) {
        await this.approveMultiSigPrice(multiSigPriceId);
      }
    }

    return { signature, signerPublicKey: this.localSignerPublicKey };
  }

  async requestRemoteSignature(
    multiSigPriceId: number,
    remoteServerUrl: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await assertSigningAllowed();

      const multiSigPrice = await prisma.multiSigPrice.findUnique({
        where: { id: multiSigPriceId },
      });

      if (!multiSigPrice) {
        return {
          success: false,
          error: `MultiSigPrice ${multiSigPriceId} not found`,
        };
      }

      const payload: SignaturePayload = {
        multiSigPriceId,
        currency: multiSigPrice.currency,
        rate: multiSigPrice.rate.toNumber(),
        source: multiSigPrice.source,
        memoId: multiSigPrice.memoId || "",
        signerPublicKey: this.localSignerPublicKey,
      };

      const response = await fetch(`${remoteServerUrl}/api/v1/price-updates/sign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.MULTI_SIG_AUTH_TOKEN || ""}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.text().catch(() => response.statusText);
        return { success: false, error: `Remote server error: ${error}` };
      }

      const result = (await response.json()) as RemoteSignatureResponse;
      if (!result.success) {
        return {
          success: false,
          error: result.error || "Remote server rejected the signing request",
        };
      }

      const signatureData = result.data;
      if (!signatureData?.signature || !signatureData.signerPublicKey) {
        return {
          success: false,
          error: "Remote server did not return signature data",
        };
      }

      let createdSignature = true;

      try {
        await prisma.multiSigSignature.create({
          data: {
            multiSigPriceId,
            signerPublicKey: signatureData.signerPublicKey,
            signerName: signatureData.signerName || "remote-signer",
            signature: signatureData.signature,
          },
        });
      } catch (error: any) {
        if (error?.code !== "P2002") {
          throw error;
        }

        createdSignature = false;
      }

      if (createdSignature) {
        const updated = await prisma.multiSigPrice.update({
          where: { id: multiSigPriceId },
          data: {
            collectedSignatures: {
              increment: 1,
            },
          },
        });

        console.info(
          `[MultiSig] Added remote signature ${updated.collectedSignatures}/${updated.requiredSignatures} for MultiSigPrice ${multiSigPriceId}`,
        );

        if (updated.collectedSignatures >= updated.requiredSignatures) {
          await this.approveMultiSigPrice(multiSigPriceId);
        }
      }

      return { success: true };
    } catch (error) {
      console.error(
        `[MultiSig] Failed to request signature from ${remoteServerUrl}:`,
        error,
      );
      return { success: false, error: String(error) };
    }
  }

  async getMultiSigPrice(multiSigPriceId: number): Promise<any> {
    return prisma.multiSigPrice.findUnique({
      where: { id: multiSigPriceId },
      include: {
        multiSigSignatures: {
          select: {
            signerPublicKey: true,
            signerName: true,
            signature: true,
            signedAt: true,
          },
        },
      },
    });
  }

  async getPendingMultiSigPrices(): Promise<any[]> {
    return prisma.multiSigPrice.findMany({
      where: { status: "PENDING" },
      include: {
        multiSigSignatures: {
          select: {
            signerPublicKey: true,
            signerName: true,
            signedAt: true,
          },
        },
      },
      orderBy: { requestedAt: "desc" },
    });
  }

  async cleanupExpiredRequests(): Promise<number> {
    const result = await prisma.multiSigPrice.updateMany({
      where: {
        status: "PENDING",
        expiresAt: { lt: new Date() },
      },
      data: {
        status: "EXPIRED",
      },
    });

    if (result.count > 0) {
      console.warn(
        `[MultiSig] Expired ${result.count} multi-sig price requests`,
      );
    }

    return result.count;
  }

  async getSignatures(multiSigPriceId: number): Promise<any[]> {
    return prisma.multiSigSignature.findMany({
      where: { multiSigPriceId },
    });
  }

  async recordSubmission(
    multiSigPriceId: number,
    memoId: string,
    stellarTxHash: string,
  ): Promise<void> {
    await prisma.multiSigPrice.update({
      where: { id: multiSigPriceId },
      data: {
        memoId,
        stellarTxHash,
        submittedAt: new Date(),
      },
    });

    console.info(
      `[MultiSig] MultiSigPrice ${multiSigPriceId} submitted to Stellar - TxHash: ${stellarTxHash}`,
    );
  }

  getLocalSignerInfo(): { publicKey: string; name: string } {
    return {
      publicKey: this.localSignerPublicKey,
      name: this.signerName,
    };
  }

  private async approveMultiSigPrice(multiSigPriceId: number): Promise<void> {
    await prisma.multiSigPrice.update({
      where: { id: multiSigPriceId },
      data: {
        status: "APPROVED",
      },
    });

    console.info(
      `[MultiSig] MultiSigPrice ${multiSigPriceId} is now APPROVED (all signatures collected)`,
    );
  }

  private createSignatureMessage(
    currency: string,
    rate: string,
    source: string,
  ): string {
    return `SF-PRICE-${currency}-${rate}-${source}`;
  }
}

export const multiSigService = new MultiSigService();
