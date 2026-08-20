import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient } from "./aws";
import { getRegistryTableName } from "./env";
import { runtimeRecordSchema, type RuntimeRecord } from "./runtime-access";

export async function getRuntimeForSubject(
  userSub: string,
): Promise<RuntimeRecord | undefined> {
  const response = await getDocumentClient().send(
    new GetCommand({
      TableName: getRegistryTableName(),
      Key: { userSub },
      ConsistentRead: true,
    }),
  );

  if (!response.Item) {
    return undefined;
  }

  const parsed = runtimeRecordSchema.safeParse(response.Item);
  if (!parsed.success) {
    throw new Error("User registry record has an invalid shape");
  }

  return parsed.data;
}
