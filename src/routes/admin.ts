import { Request, Response, Router } from "express";
import { adminMiddleware } from "../middleware/adminMiddleware";
import { setLockdownState, toggleLockdownState } from "../state/appState";

const router = Router();

/**
 * @swagger
 * /api/admin/lockdown:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Toggle or set backend lockdown mode
 *     description: Blocks all local Stellar transaction signing when enabled
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: header
 *         name: x-admin-key
 *         required: false
 *         schema:
 *           type: string
 *         description: Required when ADMIN_API_KEY is configured
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               isLocked:
 *                 type: boolean
 *                 description: Explicitly set the desired lockdown state. If omitted, the endpoint toggles the current state.
 *               reason:
 *                 type: string
 *                 description: Optional operator note recorded when enabling lockdown.
 *     responses:
 *       '200':
 *         description: Lockdown state updated successfully
 *       '400':
 *         description: Invalid request payload
 *       '403':
 *         description: Admin access denied
 */
router.post(
  "/lockdown",
  adminMiddleware,
  async (req: Request, res: Response) => {
    try {
      const requestedState = req.body?.isLocked;
      if (
        requestedState !== undefined &&
        typeof requestedState !== "boolean"
      ) {
        return res.status(400).json({
          success: false,
          error: "isLocked must be a boolean when provided",
        });
      }

      if (req.body?.reason !== undefined && typeof req.body.reason !== "string") {
        return res.status(400).json({
          success: false,
          error: "reason must be a string when provided",
        });
      }

      const reason =
        typeof req.body?.reason === "string" ? req.body.reason : undefined;
      const lockdownState =
        typeof requestedState === "boolean"
          ? await setLockdownState(requestedState, { reason })
          : await toggleLockdownState({ reason });

      return res.json({
        success: true,
        message: lockdownState.isLocked
          ? "Backend lockdown enabled. All Stellar transaction signing is blocked."
          : "Backend lockdown disabled. Stellar transaction signing is allowed.",
        data: lockdownState,
      });
    } catch (error) {
      console.error("[Admin] Failed to update lockdown state:", error);
      return res.status(500).json({
        success: false,
        error: "Failed to update lockdown state",
      });
    }
  },
);

export default router;
