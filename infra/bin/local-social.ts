#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { LocalSocialStack } from "../lib/local-social-stack";

const app = new cdk.App();

new LocalSocialStack(app, "LocalSocial", {
  env: { account: "588580411523", region: "us-east-2" },
  domainName: "plopza.com",
  // The zone the domain's name servers use (the account has two plopza.com zones).
  hostedZoneId: "Z00398401CPBX9KQ2B2VM",
  siteDomain: "social.plopza.com",
  ownerEmail: "bsweetsgf@gmail.com",
  timeZone: "America/Chicago",
  terminationProtection: true,
  description: "Local Social at social.plopza.com (shares ticket-hub's network, load balancer and database server)",
});

cdk.Tags.of(app).add("project", "local-social");
