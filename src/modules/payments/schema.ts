import { z } from "zod";

export const requestIdParamSchema = z.object({ id: z.uuid() });
