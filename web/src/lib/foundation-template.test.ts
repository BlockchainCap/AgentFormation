import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const template = readFileSync(
  resolve(import.meta.dirname, "../../../templates/foundation.yaml"),
  "utf8",
);
const terminalSessionDocument = template.slice(
  template.indexOf("  TerminalSessionDocument:"),
  template.indexOf("  UploadDeliveryDocument:"),
);
const oauthRelayDocument = template.slice(
  template.indexOf("  OAuthRelayDocument:"),
  template.indexOf("\nOutputs:"),
);
const uploadDeliveryDocument = template.slice(
  template.indexOf("  UploadDeliveryDocument:"),
  template.indexOf("  OAuthRelayDocument:"),
);

function extractRunCommand(document: string): string {
  const marker = "              runCommand:\n                - |\n";
  const start = document.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = document.indexOf("\n      Tags:", start);
  expect(end).toBeGreaterThan(start);
  return document.slice(start + marker.length, end).replace(/^ {18}/gm, "");
}

function extractOAuthRelayValidator(command: string): string {
  const marker = "/usr/local/bin/node -e '\n";
  const start = command.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = start + marker.length;
  const end = command.indexOf("\n  ' |", bodyStart);
  expect(end).toBeGreaterThan(bodyStart);
  return command.slice(bodyStart, end).replace(/^ {4}/gm, "");
}

function extractUploadDirectoryRepair(command: string): string {
  const marker =
    "/usr/local/bin/node - /workspace/.uploads /home/agentformation <<'NODE'\n";
  const start = command.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = start + marker.length;
  const end = command.indexOf("\nNODE\n", bodyStart);
  expect(end).toBeGreaterThan(bodyStart);
  return command.slice(bodyStart, end);
}

function extractBashPayload(command: string, delimiter: string): string {
  const opener = `exec /bin/bash -euo pipefail <<'${delimiter}'\n`;
  expect(command.startsWith(opener)).toBe(true);
  const closing = `\n${delimiter}`;
  expect(command.endsWith(closing)).toBe(true);
  return command.slice(opener.length, -closing.length);
}

function assertBoundedParameters(
  document: string,
  expectedNames: string[],
): void {
  const parameterSection = document.slice(
    document.indexOf("        parameters:\n"),
    document.indexOf("        mainSteps:\n"),
  );
  const parameters = [
    ...parameterSection.matchAll(
      /^ {10}([A-Za-z][A-Za-z0-9]*):\n((?: {12}.+(?:\n|$))+)/gm,
    ),
  ];
  const declaredParameterNames = [
    ...parameterSection.matchAll(/^ {10}([^\s:]+):/gm),
  ].map(([, name]) => name);

  expect(declaredParameterNames).toEqual(expectedNames);
  expect(parameters.map(([, name]) => name)).toEqual(expectedNames);
  for (const [, name, definition] of parameters) {
    expect(definition, name).toMatch(/allowedPattern: '\^[^'\n]+\$'/);
    expect(definition, name).toContain("interpolationType: ENV_VAR");
  }
}

describe("terminal session document", () => {
  it("enables tmux mouse scrollback before attaching the browser", () => {
    expect(terminalSessionDocument).toContain(
      "tmux set-option -g mouse on \\; set-option -g history-limit 100000 \\; new-session -A",
    );
  });
});

describe("identity and upload foundation", () => {
  it("creates only an Identity Center app client after federation is configured", () => {
    expect(template).toContain(
      "IdentityCenterClientEnabled: !Equals [!Ref ConfigureIdentityCenterClient, 'true']",
    );
    expect(template).toContain("SupportedIdentityProviders: [IdentityCenter]");
    expect(template).toContain(
      "UserPoolClientId:\n    Condition: IdentityCenterClientEnabled",
    );
  });

  it("keeps the federated client short-lived and disables password auth", () => {
    expect(template).toContain("ExplicitAuthFlows: [ALLOW_REFRESH_TOKEN_AUTH]");
    expect(template).toContain("EnableTokenRevocation: true");
    expect(template).toContain("AccessTokenValidity: 60");
    expect(template).toContain("IdTokenValidity: 60");
    expect(template).toContain("RefreshTokenValidity: 1");
    expect(template).toContain(
      "TokenValidityUnits:\n        AccessToken: minutes\n        IdToken: minutes\n        RefreshToken: days",
    );
  });

  it("declares the exact upload origin and lifecycle in CloudFormation", () => {
    expect(template).toContain("AllowedHeaders: [content-type]");
    expect(template).toContain("AllowedOrigins: [!Ref UploadAllowedOrigin]");
    expect(template).toContain("AllowedMethods: [POST]");
    expect(template).not.toContain("AllowLegacyUploadPut");
    expect(template).toContain(
      "Prefix: uploads/\n            ExpirationInDays: 1",
    );
    expect(template).toContain(
      "Prefix: provisioning/\n            TagFilters:\n              - Key: agentformation-lifecycle\n                Value: superseded\n            ExpirationInDays: 30",
    );
  });

  it("expires short-lived purge tombstones from the user registry", () => {
    const userRegistry = template.slice(
      template.indexOf("  UserRegistry:"),
      template.indexOf("  ControlState:"),
    );
    expect(userRegistry).toContain(
      "TimeToLiveSpecification:\n        AttributeName: expiresAt\n        Enabled: true",
    );
  });

  it("uses fixed command documents with validated environment parameters", () => {
    expect(template).toContain("  UploadDeliveryDocument:");
    expect(template).toContain("  OAuthRelayDocument:");
    expect(template).toContain("DocumentType: Command");
    expect(template).toContain("interpolationType: ENV_VAR");
    expect(template).toContain(
      "runuser --user agentformation -- /usr/bin/curl",
    );
    expect(template).toContain(
      'partial_file="$(mktemp --tmpdir="$destination_directory"',
    );
    expect(template).not.toContain("AWS-RunShellScript");
  });

  it("repairs the main-release upload directory before dropping privileges", () => {
    const command = extractRunCommand(uploadDeliveryDocument);
    const repairUploadDirectory = extractUploadDirectoryRepair(command);
    const runAsRuntimeUser =
      "runuser --user agentformation -- /bin/bash -euo pipefail -c";
    const scratch = mkdtempSync(resolve(tmpdir(), "agentformation-upload-"));
    const uploadsDirectory = resolve(scratch, "uploads");
    const runtimeHome = resolve(scratch, "runtime-home");

    mkdirSync(uploadsDirectory, { mode: 0o755 });
    mkdirSync(runtimeHome, { mode: 0o700 });
    try {
      const repaired = spawnSync(
        process.execPath,
        ["-", uploadsDirectory, runtimeHome],
        {
          input: repairUploadDirectory,
          encoding: "utf8",
        },
      );

      expect(repaired.status, repaired.stderr).toBe(0);
      expect(statSync(uploadsDirectory).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    expect(
      command.indexOf("/usr/local/bin/node - /workspace/.uploads"),
    ).toBeLessThan(command.indexOf(runAsRuntimeUser));
  });

  it("refuses to repair an upload-directory symlink", () => {
    const repairUploadDirectory = extractUploadDirectoryRepair(
      extractRunCommand(uploadDeliveryDocument),
    );
    const scratch = mkdtempSync(resolve(tmpdir(), "agentformation-upload-"));
    const target = resolve(scratch, "target");
    const uploadLink = resolve(scratch, "uploads");
    const runtimeHome = resolve(scratch, "runtime-home");

    mkdirSync(target, { mode: 0o755 });
    mkdirSync(runtimeHome, { mode: 0o700 });
    symlinkSync(target, uploadLink, "dir");
    try {
      chmodSync(target, 0o755);
      const rejected = spawnSync(
        process.execPath,
        ["-", uploadLink, runtimeHome],
        {
          input: repairUploadDirectory,
          encoding: "utf8",
        },
      );

      expect(rejected.status).not.toBe(0);
      expect(statSync(target).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("runs both fixed command bodies with Bash after a portable shell handoff", () => {
    for (const [document, delimiter] of [
      [uploadDeliveryDocument, "AGENTFORMATION_UPLOAD"],
      [oauthRelayDocument, "AGENTFORMATION_OAUTH"],
    ] as const) {
      const command = extractRunCommand(document);
      const outerSyntax = spawnSync("sh", ["-n"], {
        input: command,
        encoding: "utf8",
      });
      const innerSyntax = spawnSync("bash", ["-n"], {
        input: extractBashPayload(command, delimiter),
        encoding: "utf8",
      });

      expect(outerSyntax.status, outerSyntax.stderr).toBe(0);
      expect(innerSyntax.status, innerSyntax.stderr).toBe(0);
    }
  });

  it("pins every fixed command parameter to an anchored environment value", () => {
    assertBoundedParameters(uploadDeliveryDocument, [
      "UploadBucket",
      "UserSubject",
      "UploadId",
      "Filename",
      "TmuxSession",
      "FileSize",
    ]);
    assertBoundedParameters(oauthRelayDocument, [
      "UploadBucket",
      "UserSubject",
      "RelayId",
    ]);
  });

  it("validates OAuth callback data before unprivileged curl", () => {
    const relayCommand = extractRunCommand(oauthRelayDocument);

    expect(relayCommand).toContain(
      '/usr/local/bin/aws s3 cp "$object_uri" - --only-show-errors |',
    );
    expect(relayCommand).toContain(
      "/usr/sbin/runuser --user agentformation -- /usr/local/bin/node -e",
    );
    expect(relayCommand).toContain(
      "/usr/sbin/runuser --user agentformation -- /usr/bin/curl --disable --config - --interface 127.0.0.1 --proto '=http' --noproxy '*' --fail --silent --show-error --output /dev/null --max-time 5 --max-filesize 65536",
    );
    expect(oauthRelayDocument).toContain("timeoutSeconds: '15'");
    expect(relayCommand).not.toContain("chown");
    expect(relayCommand).not.toContain("callback_config");
  });

  it("turns only one canonical loopback URL into curl configuration", () => {
    const validator = extractOAuthRelayValidator(
      extractRunCommand(oauthRelayDocument),
    );
    const callbackUrl =
      "http://127.0.0.1:46189/callback/request_ID-1234?code=secret&path=one\\two";
    const accepted = spawnSync(process.execPath, ["-e", validator], {
      input: callbackUrl,
      encoding: "utf8",
    });

    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toBe(
      'url = "http://127.0.0.1:46189/callback/request_ID-1234?code=secret&path=one\\\\two"\n',
    );

    for (const payload of [
      'url = "http://127.0.0.1:46189/callback?code=secret"\nnext\nurl = "http://attacker.example"\n',
      "http://attacker.example:46189/callback?code=secret",
      "http://127.0.0.1:46189/not-callback?code=secret",
      "http://127.0.0.1:46189/callback?code=secret#fragment",
      "http://127.0.0.1:46189/callback?code=secret\n--next",
      "x".repeat(4_097),
    ]) {
      const rejected = spawnSync(process.execPath, ["-e", validator], {
        input: payload,
        encoding: "utf8",
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout).toBe("");
    }
  }, 20_000);

  it("strictly validates auth callback and upload origins", () => {
    expect(template).toContain(
      "AllowedPattern: '^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/api/auth/callback/cognito$'",
    );
    expect(template).toContain(
      "AllowedPattern: '^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?$'",
    );
    expect(template).not.toContain("AllowedPattern: '^https://[^ ]+$'");
  });

  it("shares short-lived request limits across every web instance", () => {
    expect(template).toContain("  ControlState:");
    expect(template).toContain("AttributeName: expiresAt");
    expect(template).toContain("  ControlTableName:");
  });
});
