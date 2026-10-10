import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elbv2Actions from "aws-cdk-lib/aws-elasticloadbalancingv2-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";

export interface LocalSocialStackProps extends cdk.StackProps {
  /** The domain whose Route 53 hosted zone we add records to, e.g. plopza.com */
  domainName: string;
  hostedZoneId: string;
  /** Where the site is served, e.g. social.plopza.com */
  siteDomain: string;
  /** Always an admin, so the owner can't be locked out */
  ownerEmail: string;
  /** The time zone admin pages show times in */
  timeZone: string;
}

/**
 * Local Social. To save money it shares ticket-hub's network, load balancer
 * and database server (see incatch/ticket-hub, which publishes them under
 * /household/shared/ in Parameter Store), like the other household apps:
 *
 *   social.plopza.com ──HTTPS──► ticket-hub's load balancer ──► Local Social container (Fargate)
 *                                (/admin: household sign-in)        │          │
 *                                                photos (private S3) ◄┘          ▼
 *                                              "social" database on ticket-hub's database server
 *
 * People sign in on the site itself with an emailed code (not the household
 * sign-in); only Admin asks for the household sign-in at the load balancer.
 */
export class LocalSocialStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LocalSocialStackProps) {
    super(scope, id, props);

    // Values ticket-hub publishes; read when this is deployed.
    const shared = (name: string) => ssm.StringParameter.valueForStringParameter(this, `/household/shared/${name}`);
    const siteUrl = `https://${props.siteDomain}`;

    // ── ticket-hub's network ─────────────────────────────────────────────
    const subnetIds = cdk.Fn.split(",", shared("public-subnet-ids"), 2);
    // (The shared subnets' route tables aren't needed here.)
    cdk.Annotations.of(this).acknowledgeWarning("@aws-cdk/aws-ec2:noSubnetRouteTableId");
    const vpc = ec2.Vpc.fromVpcAttributes(this, "Network", {
      vpcId: shared("vpc-id"),
      availabilityZones: ["us-east-2a", "us-east-2b"],
      publicSubnetIds: [cdk.Fn.select(0, subnetIds), cdk.Fn.select(1, subnetIds)],
    });

    // ── Domain and HTTPS certificate ─────────────────────────────────────
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.domainName,
    });
    const certificate = new acm.Certificate(this, "Certificate", {
      domainName: props.siteDomain,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // ── ticket-hub's load balancer ───────────────────────────────────────
    // Read-only here (as in glamping): the one rule we need, to reach our
    // website, is added explicitly below.
    const albSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, "LoadBalancerFirewall", shared("alb-security-group-id"), {
      mutable: false,
    });
    const loadBalancer = elbv2.ApplicationLoadBalancer.fromApplicationLoadBalancerAttributes(this, "LoadBalancer", {
      loadBalancerArn: shared("alb-arn"),
      securityGroupId: albSecurityGroup.securityGroupId,
      loadBalancerDnsName: shared("alb-dns-name"),
      loadBalancerCanonicalHostedZoneId: shared("alb-zone-id"),
    });
    const listener = elbv2.ApplicationListener.fromApplicationListenerAttributes(this, "HttpsListener", {
      listenerArn: shared("https-listener-arn"),
      securityGroup: albSecurityGroup,
    });
    new elbv2.ApplicationListenerCertificate(this, "ListenerCertificate", {
      listener,
      certificates: [elbv2.ListenerCertificate.fromCertificateManager(certificate)],
    });
    new route53.ARecord(this, "SiteAddress", {
      zone,
      recordName: props.siteDomain,
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(loadBalancer)),
    });

    // ── Storage and secrets ──────────────────────────────────────────────
    // Profile photos (and, later, posts and snaps). Private: the site serves
    // them itself, to signed-in people only.
    const media = new s3.Bucket(this, "Media", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Keep people's photos if the stack is ever deleted.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // ticket-hub's database server login. The site keeps its data in its own
    // database ("social") on that server, created on first start.
    const dbSecret = secretsmanager.Secret.fromSecretCompleteArn(this, "DatabaseLogin", shared("db-secret-arn"));
    // Signs each device's "remember me" pass and the admin forms. Changing it
    // signs everyone out.
    const sessionSecret = new secretsmanager.Secret(this, "SessionSecret", {
      secretName: "local-social/sessions",
      description: "Signs Local Social's remember-this-device passes",
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });

    // The site's entry in the household sign-in (for Admin).
    const userPool = cognito.UserPool.fromUserPoolId(this, "HouseholdSignIn", shared("user-pool-id"));
    const signInDomain = cognito.UserPoolDomain.fromDomainName(this, "SignInPage", shared("sign-in-domain-prefix"));
    const signInBaseUrl = `https://${signInDomain.domainName}.auth.${this.region}.amazoncognito.com`;
    const signInClient = new cognito.UserPoolClient(this, "SignInClient", {
      userPool,
      userPoolClientName: "local-social",
      generateSecret: true, // required by the load balancer
      authFlows: { user: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${siteUrl}/oauth2/idpresponse`],
        logoutUrls: [`${siteUrl}/`],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
    });
    new cognito.CfnManagedLoginBranding(this, "SignInPageStyle", {
      userPoolId: userPool.userPoolId,
      clientId: signInClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    // ── The website ──────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, "Cluster", { vpc, clusterName: "local-social" });
    const logGroup = new logs.LogGroup(this, "WebLogs", {
      logGroupName: "/local-social/web",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const emailFrom = `social@${props.domainName}`;
    const task = new ecs.FargateTaskDefinition(this, "WebTask", {
      family: "local-social-web",
      cpu: 256, // 0.25 vCPU
      memoryLimitMiB: 1024, // room to resize big phone photos
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    task.addContainer("web", {
      containerName: "web",
      // The whole repository is the build (see ../../.dockerignore for what goes in).
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, "..", ".."), {
        platform: cdk.aws_ecr_assets.Platform.LINUX_AMD64,
      }),
      portMappings: [{ containerPort: 8080 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "web", logGroup }),
      environment: {
        PORT: "8080",
        SITE_URL: siteUrl,
        OWNER_EMAIL: props.ownerEmail,
        LOAD_BALANCER_ARN: loadBalancer.loadBalancerArn,
        SIGN_OUT_URL: `${signInBaseUrl}/logout?client_id=${signInClient.userPoolClientId}&logout_uri=${encodeURIComponent(`${siteUrl}/`)}`,
        DB_NAME: "social",
        // The database on the server that already exists (ticket-hub's),
        // used once to create the social database.
        DB_ADMIN_DATABASE: "tickethub",
        EMAIL_FROM: `Local Social <${emailFrom}>`,
        MEDIA_BUCKET: media.bucketName,
        SITE_TIME_ZONE: props.timeZone,
      },
      secrets: {
        DB_HOST: ecs.Secret.fromSecretsManager(dbSecret, "host"),
        DB_PORT: ecs.Secret.fromSecretsManager(dbSecret, "port"),
        DB_USER: ecs.Secret.fromSecretsManager(dbSecret, "username"),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
        SESSION_SECRET: ecs.Secret.fromSecretsManager(sessionSecret),
      },
    });
    media.grantReadWrite(task.taskRole);
    media.grantDelete(task.taskRole);
    // Emails go out only ever from social@<domain>.
    task.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: [`arn:aws:ses:${this.region}:${this.account}:identity/*`],
        conditions: { StringLike: { "ses:FromAddress": [emailFrom, `*<${emailFrom}>`] } },
      }),
    );

    const firewall = new ec2.SecurityGroup(this, "WebFirewall", {
      vpc,
      description: "Local Social: only the load balancer comes in",
      allowAllOutbound: true,
    });
    // The load balancer may reach the website (the way in is added when the
    // service joins the target group below; this is the way out)...
    new ec2.CfnSecurityGroupEgress(this, "LoadBalancerToSite", {
      groupId: albSecurityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 8080,
      toPort: 8080,
      destinationSecurityGroupId: firewall.securityGroupId,
      description: "Load balancer to Local Social",
    });
    // ...and the website may reach the database server.
    new ec2.CfnSecurityGroupIngress(this, "DatabaseFromSite", {
      groupId: shared("db-security-group-id"),
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: firewall.securityGroupId,
      description: "Local Social to PostgreSQL",
    });

    const service = new ecs.FargateService(this, "Web", {
      cluster,
      serviceName: "web",
      taskDefinition: task,
      desiredCount: 1,
      vpcSubnets: { subnets: vpc.publicSubnets },
      assignPublicIp: true, // no NAT gateway; the firewall still blocks direct access
      securityGroups: [firewall],
      circuitBreaker: { rollback: true }, // a broken release rolls itself back
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "WebTargets", {
      vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [service],
      healthCheck: { path: "/health", healthyHttpCodes: "200", interval: cdk.Duration.seconds(30) },
      deregistrationDelay: cdk.Duration.seconds(15),
    });

    // Our rules come before ticket-hub's (priorities 1–9 are kept for other
    // apps; glamping has 1–2, the raffle site 3–4, flight deals 5–6) and
    // only match our address.
    // Admin asks for the household sign-in; everything else is public.
    new elbv2.ApplicationListenerRule(this, "AdminRule", {
      listener,
      priority: 7,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([props.siteDomain]),
        elbv2.ListenerCondition.pathPatterns(["/admin", "/admin/*", "/oauth2/idpresponse"]),
      ],
      action: new elbv2Actions.AuthenticateCognitoAction({
        userPool,
        userPoolClient: signInClient,
        userPoolDomain: signInDomain,
        scope: "openid email profile",
        sessionTimeout: cdk.Duration.days(7),
        onUnauthenticatedRequest: elbv2.UnauthenticatedAction.AUTHENTICATE,
        next: elbv2.ListenerAction.forward([targetGroup]),
      }),
    });
    new elbv2.ApplicationListenerRule(this, "SiteRule", {
      listener,
      priority: 8,
      conditions: [elbv2.ListenerCondition.hostHeaders([props.siteDomain])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    new cdk.CfnOutput(this, "SiteUrl", { value: siteUrl });
    new cdk.CfnOutput(this, "MediaBucket", { value: media.bucketName });
  }
}
