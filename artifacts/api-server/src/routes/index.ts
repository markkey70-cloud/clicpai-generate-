import { Router, type IRouter } from "express";
import healthRouter from "./health";
import videoRouter from "./video";
import soundRouter from "./sound";
import billingRouter from "./billing";

const router: IRouter = Router();

router.use(healthRouter);
router.use(videoRouter);
router.use(soundRouter);
router.use(billingRouter);

export default router;
