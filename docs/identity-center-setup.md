# IAM Identity Center sign-in setup

AgentFormation uses your organization's existing AWS IAM Identity Center session.
It does not ask employees to create another password or configure another MFA
method. Amazon Cognito sits between Identity Center and the web app only to turn
the SAML company sign-in into the OIDC tokens used by the app.

This setup requires an **organization instance** of IAM Identity Center and an
administrator who can add customer-managed applications and assign groups. An AWS
account instance of Identity Center is not enough for customer-managed SAML apps.

AWS currently allows customer-managed SAML application creation and SAML
attribute mapping only in the IAM Identity Center console. Its
[public application API](https://docs.aws.amazon.com/singlesignon/latest/APIReference/API_CreateApplication.html)
and CloudFormation resource support customer-managed OAuth applications but not
this SAML configuration. Sections 2 through 4 are therefore one-time console
work. The AgentFormation command handles the Cognito connection and all other
deployment resources.

## 1. Create the identity bootstrap

Leave both `identityCenter.metadataUrl` and `identityCenter.metadataFile` empty in
`agentformation.local.json`, then run:

```bash
AWS_PROFILE=your-profile ./agentformation deploy
```

The command creates the Cognito user pool and prints two account-specific values:

```text
SAML ACS URL: https://...
SAML audience: urn:amazon:cognito:sp:...
```

The command then exits successfully. This is expected; the web app is not
published with a local password fallback.

## 2. Add the SAML application

In the IAM Identity Center console:

1. Open **Applications**, choose **Customer managed**, then **Add application**.
2. Choose **I have an application I want to set up**, then **SAML 2.0**.
3. Use `AgentFormation` as the display name and add a description your employees
   will recognize.
4. Under **IAM Identity Center metadata**, copy the HTTPS address shown for the
   **IAM Identity Center SAML metadata file**. The **Default (IPv4 only)** address
   is sufficient unless your organization specifically requires dual-stack
   endpoints. Keep this address private to your organization.
5. Leave **Application start URL** and **Relay state** blank. The default one-hour
   session duration is a reasonable starting point; your organization's normal
   Identity Center and upstream identity-provider policies still apply.
6. Under **Application metadata**, choose **Manually type your metadata values**.
7. Paste the printed **SAML ACS URL** into **Application ACS URL**.
8. Paste the printed **SAML audience** into **Application SAML audience**.
9. Choose **Submit**.

If the console exposes only a **Download** action rather than an address, download
the complete metadata XML. AgentFormation supports that file as a fallback.

AgentFormation accepts service-provider-initiated sign-ins only. Employees begin
at the AgentFormation web address and are sent to Identity Center; an unsolicited
SAML response is not accepted.

## 3. Map the stable identity and employee email

On the new application's detail page, choose **Actions**, then **Edit attribute
mappings**. Set these mappings:

| Application attribute | IAM Identity Center value | Format        |
| --------------------- | ------------------------- | ------------- |
| `Subject`             | `${user:subject}`         | `persistent`  |
| `email`               | `${user:email}`           | `unspecified` |

The employee email must be present and unique in Identity Center. Cognito requests
a persistent SAML NameID, so the `Subject` row must use Identity Center's stable
`${user:subject}` value with the `persistent` format. The separate `email` row is
used for display and administration. AgentFormation uses Cognito's stable
federated subject, not the email string, as the actual runtime access key.

## 4. Assign a dedicated access group

On the application's **Assigned users and groups** tab, choose **Assign users and
groups**. The recommended setup is a dedicated group such as
`AgentFormationUsers`. Create and manage it in the directory that owns your
workforce identities: the built-in Identity Center directory, or an external
provider such as Okta or Google Workspace when users and groups are synchronized
into AWS. Do not create a second manual copy of an externally managed group. Add
one test employee directly to the synchronized group, then assign the group to
the application. IAM Identity Center does not honor nested-group membership for
application assignments.

You may reuse an existing employee or developer group only when every direct
member should be allowed to create an AgentFormation runtime and incur its AWS
cost. For a one-person test, directly assigning that one Identity Center user to
the application is also acceptable; replace the direct assignment with the
dedicated group before a wider rollout.

Application assignment controls who can sign in to AgentFormation. It does not
grant those employees new AWS console roles or permission sets. An IAM user is a
different kind of identity and cannot be added to an IAM Identity Center group;
assign the employee's Identity Center user or group instead.

An Identity Center administrator can assign a broader admin group too. Do not use
the AWS root user: root is a separate emergency identity and does not sign in
through Identity Center.

## 5. Finish the deployment

Put the copied metadata address in `agentformation.local.json`, which Git ignores:

```json
"identityCenter": {
  "metadataUrl": "https://your-identity-center-metadata-address",
  "metadataFile": ""
}
```

The metadata contains organization-specific SAML endpoints and public signing
certificates. It is not a password or private key, but it still does not belong in
the public repository, issue comments, screenshots, or logs.

If you downloaded the XML fallback, save it under the ignored local state
directory:

```text
.agentformation/identity-center-metadata.xml
```

Then use this configuration instead:

```json
"identityCenter": {
  "metadataUrl": "",
  "metadataFile": ".agentformation/identity-center-metadata.xml"
}
```

Set exactly one of `metadataUrl` or `metadataFile`, never both.

Then run:

```bash
AWS_PROFILE=your-profile ./agentformation doctor
AWS_PROFILE=your-profile ./agentformation deploy
```

The deploy command configures the Cognito SAML bridge and does not print the
metadata or generated client secret. A metadata URL is preferred because Cognito
refreshes it automatically, normally about every six hours or before the metadata
expires. With a downloaded XML file, rerun the deployment whenever Identity
Center signing metadata changes.

## 6. Verify the employee experience

After adding a new application or assignment, sign out of the AWS access portal
and sign back in before testing. AWS can take up to one hour to show a newly
assigned application inside an existing portal session. A private browser window
is a simple way to force a fresh sign-in.

1. Open the printed AgentFormation address in the fresh browser session.
2. Choose **Continue with company SSO**.
3. Confirm the browser goes directly to your normal company sign-in. Once the new
   assignment is visible to Identity Center, the employee returns without a
   separate AgentFormation credential prompt.
4. Choose **Create environment**.
5. Wait for the page to report the environment is ready, then confirm the terminal
   opens in `/workspace`.

Test with one assigned employee and one unassigned employee before wider use. The
assigned employee should be able to create only one environment. The unassigned
employee should be rejected by Identity Center before reaching AgentFormation.

## Access removal

Remove an employee from the assigned Identity Center group when their access
should end. For an immediate app-side block and stopped EC2 bill, also run:

```bash
AWS_PROFILE=your-profile ./agentformation users disable --email person@example.com
```

Use `users enable` to restore a preserved runtime. Before permanently purging a
runtime, remove the employee's application assignment; otherwise that employee is
still approved by Identity Center and can create a new environment after signing
in again.

AWS references: [customer-managed SAML application setup](https://docs.aws.amazon.com/singlesignon/latest/userguide/customermanagedapps-set-up-your-own-app-saml2.html),
[application assignments and the nested-group limitation](https://docs.aws.amazon.com/singlesignon/latest/userguide/assignuserstoapp.html),
[application attribute mappings](https://docs.aws.amazon.com/singlesignon/latest/userguide/mapawsssoattributestoapp.html), and
[Cognito SAML identity providers](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-saml-idp.html), including
[why a metadata URL is preferred](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-managing-saml-idp.html).
