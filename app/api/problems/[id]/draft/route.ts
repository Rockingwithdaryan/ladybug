import { handle } from "@/server/http";
import { deleteDraft, putDraft } from "@/server/problems";

export const PUT = handle(putDraft);
export const DELETE = handle(deleteDraft);
