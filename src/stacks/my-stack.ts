import { join } from "node:path";
import {
  Aspects,
  CfnOutput,
  DockerImage,
  Duration,
  type IAspect,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import { EndpointType, LambdaIntegration, RestApi } from "aws-cdk-lib/aws-apigateway";
import { AttributeType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Stream } from "aws-cdk-lib/aws-kinesis";
import {
  ApplicationLogLevel,
  Architecture,
  Function,
  FunctionUrlAuthType,
  LayerVersion,
  LoggingFormat,
  Runtime,
  StartingPosition,
  SystemLogLevel,
} from "aws-cdk-lib/aws-lambda";
import { KinesisEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Schedule, ScheduleExpression } from "aws-cdk-lib/aws-scheduler";
import { LambdaInvoke } from "aws-cdk-lib/aws-scheduler-targets";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { RustExtension, RustFunction } from "cargo-lambda-cdk";
import type { Construct, IConstruct } from "constructs";
import { PythonFunction } from "uv-python-lambda";
import { validateEnv } from "../utils/validate-env";

const env = validateEnv([
  "CLICKHOUSE_ENDPOINT",
  "CLICKHOUSE_DATABASE",
  "CLICKHOUSE_USERNAME",
  "CLICKHOUSE_PASSWORD",
]);

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    //==============================================================================
    // QUOTES TABLE (DDB)
    //==============================================================================

    const quotesTable = new TableV2(this, "QuotesTable", {
      tableName: "quotes-table",
      partitionKey: { name: "pk", type: AttributeType.STRING },
      timeToLiveAttribute: "expiry",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    //==============================================================================
    // BACKEND API (APIGW)
    //==============================================================================

    const backendApi = new RestApi(this, "BackendApi", {
      restApiName: "backend-api",
      endpointTypes: [EndpointType.REGIONAL],
    });
    backendApi.node.tryRemoveChild("Endpoint");

    //==============================================================================
    // APP FUNCTIONS (LAMBDA)
    //==============================================================================

    // App Backend Function
    const appBackend = new RustFunction(this, "AppBackend", {
      functionName: "app-backend",
      manifestPath: join(__dirname, "../functions/app-backend", "Cargo.toml"),
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      bundling: { cargoLambdaFlags: ["--quiet"] },
      environment: {
        TABLE_NAME: quotesTable.tableName,
      },
    });
    quotesTable.grantReadWriteData(appBackend);

    // App Frontend Function
    const appFrontend = new RustFunction(this, "AppFrontend", {
      functionName: "app-frontend",
      manifestPath: join(__dirname, "../functions/app-frontend", "Cargo.toml"),
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      bundling: { cargoLambdaFlags: ["--quiet"] },
      environment: {
        LAMBDA_EXTENSION_SPAN_PROCESSOR_MODE: "async",
        TARGET_URL: backendApi.url,
      },
    });
    const appFrontendUrl = appFrontend.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
    });

    //==============================================================================
    // BACKEND API ROUTES (APIGW)
    //==============================================================================

    // {api}/quotes
    const quotesResource = backendApi.root.resourceForPath("/quotes");
    quotesResource.addMethod("GET", new LambdaIntegration(appBackend));
    quotesResource.addMethod("POST", new LambdaIntegration(appBackend));

    // {api}/quotes/{id}
    const quoteByIdResource = backendApi.root.resourceForPath("/quotes/{id}");
    quoteByIdResource.addMethod("GET", new LambdaIntegration(appBackend));

    //==============================================================================
    // CLIENT FUNCTIONS (LAMBDA)
    //==============================================================================

    // Client Node Function
    const clientNode = new NodejsFunction(this, "ClientNode", {
      functionName: "client-node",
      entry: join(__dirname, "../functions/client-node", "index.ts"),
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      environment: {
        LAMBDA_EXTENSION_SPAN_PROCESSOR_MODE: "async",
        TARGET_URL: `${backendApi.url}quotes`,
      },
    });
    new Schedule(this, "ClientNodeSchedule", {
      scheduleName: `client-node-schedule`,
      description: `Trigger ${clientNode.functionName} every 5 minutes`,
      schedule: ScheduleExpression.rate(Duration.minutes(5)),
      target: new LambdaInvoke(clientNode),
    });

    // Client Python Function
    const clientPython = new PythonFunction(this, "ClientPython", {
      functionName: "client-python",
      rootDir: join(__dirname, "../functions/client-python"),
      runtime: Runtime.PYTHON_3_13,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      bundling: {
        image: DockerImage.fromBuild(join(__dirname, "../functions/client-python")),
        assetExcludes: ["Dockerfile", ".venv"],
      },
      environment: {
        LAMBDA_EXTENSION_SPAN_PROCESSOR_MODE: "async",
        TARGET_URL: `${backendApi.url}quotes`,
      },
    });
    new Schedule(this, "ClientPythonSchedule", {
      scheduleName: `client-python-schedule`,
      description: `Trigger ${clientPython.functionName} every 5 minutes`,
      schedule: ScheduleExpression.rate(Duration.minutes(5)),
      target: new LambdaInvoke(clientPython),
    });

    // Client Rust Function
    const clientRust = new RustFunction(this, "ClientRust", {
      functionName: "client-rust",
      manifestPath: join(__dirname, "../functions/client-rust", "Cargo.toml"),
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(1),
      loggingFormat: LoggingFormat.JSON,
      bundling: { cargoLambdaFlags: ["--quiet"] },
      environment: {
        LAMBDA_EXTENSION_SPAN_PROCESSOR_MODE: "async",
      },
    });
    const clientRustUrl = clientRust.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
    });

    //==============================================================================
    // OTLP FORWARDER (LAMBDA)
    //==============================================================================

    const rotelCollectorLayer = LayerVersion.fromLayerVersionArn(
      this,
      "RotelCollectorLayer",
      `arn:aws:lambda:${this.region}:418653438961:layer:rotel-extension-arm64-alpha:27`,
    );

    const rotelChConfig = new Secret(this, "RotelChConfig", {
      secretName: "rotel-ch-config",
      description: "ClickHouse config for ROTel Collector",
      secretObjectValue: {
        endpoint: SecretValue.unsafePlainText(env.CLICKHOUSE_ENDPOINT),
        database: SecretValue.unsafePlainText(env.CLICKHOUSE_DATABASE),
        user: SecretValue.unsafePlainText(env.CLICKHOUSE_USERNAME),
        password: SecretValue.unsafePlainText(env.CLICKHOUSE_PASSWORD),
      },
    });

    const otlpChForwarder = new RustFunction(this, "OtlpChForwarder", {
      functionName: "otlp-ch-forwarder",
      manifestPath: join(__dirname, "../functions/otlp-forwarder-cwl", "Cargo.toml"),
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(15),
      loggingFormat: LoggingFormat.JSON,
      systemLogLevelV2: SystemLogLevel.WARN,
      applicationLogLevelV2: ApplicationLogLevel.INFO,
      bundling: { cargoLambdaFlags: ["--quiet"] },
      layers: [rotelCollectorLayer],
      environment: {
        // Lambda OTel Lite
        LAMBDA_EXTENSION_SPAN_PROCESSOR_MODE: "async",
        LAMBDA_TRACING_ENABLE_FMT_LAYER: "true",
        // OTel SDK
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
        // ROTel Collector (Lambda Extension)
        ROTEL_EXPORTER: "clickhouse",
        ROTEL_CLICKHOUSE_EXPORTER_ENDPOINT: "${" + rotelChConfig.secretArn + "#endpoint}",
        ROTEL_CLICKHOUSE_EXPORTER_DATABASE: "${" + rotelChConfig.secretArn + "#database}",
        ROTEL_CLICKHOUSE_EXPORTER_USER: "${" + rotelChConfig.secretArn + "#user}",
        ROTEL_CLICKHOUSE_EXPORTER_PASSWORD: "${" + rotelChConfig.secretArn + "#password}",
      },
    });
    otlpChForwarder.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:BatchGetSecretValue"],
        resources: ["*"],
      }),
    );

    //==============================================================================
    // OTLP TRANSPORT (KINESIS)
    //==============================================================================

    const otlpStream = new Stream(this, "otlpStream", {
      streamName: `otlp-stream`,
      shardCount: 1,
      retentionPeriod: Duration.days(1),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    otlpChForwarder.addEventSource(
      new KinesisEventSource(otlpStream, {
        startingPosition: StartingPosition.LATEST,
        batchSize: 100,
        maxBatchingWindow: Duration.seconds(5),
      }),
    );

    //==============================================================================
    // OTLP STDOUT KINESIS EXTENSION (LAMBDA)
    //==============================================================================

    const otlpStdoutKinesisExtension = new RustExtension(this, "OtlpStdoutKinesisExtension", {
      layerVersionName: "otlp-stdout-kinesis-extension",
      manifestPath: join(__dirname, "../layers/otlp-stdout-kinesis-extension", "Cargo.toml"),
      architecture: Architecture.ARM_64,
      bundling: { cargoLambdaFlags: ["--quiet"] },
    });

    //==============================================================================
    // APPLY ASPECTS
    //==============================================================================

    Aspects.of(this).add(new ApplyKinesisExtensionAspect(otlpStream, otlpStdoutKinesisExtension));

    //==============================================================================
    // OUTPUTS
    //==============================================================================

    new CfnOutput(this, "QuotesApiUrl", {
      value: `${backendApi.url}quotes`,
    });

    new CfnOutput(this, "AppFrontendUrl", {
      value: appFrontendUrl.url,
    });

    new CfnOutput(this, "ClientRustLambdaUrl", {
      value: clientRustUrl.url,
    });
  }
}

//==============================================================================
// CDK ASPECTS
//==============================================================================

class ApplyKinesisExtensionAspect implements IAspect {
  constructor(
    private readonly kinesisStream: Stream,
    private readonly extensionLayer: LayerVersion,
  ) {}

  public visit(node: IConstruct): void {
    if (node instanceof Function) {
      // Add the extension layer
      node.addLayers(this.extensionLayer);

      // Grant write permissions to the Kinesis stream
      if (node.role) {
        this.kinesisStream.grantWrite(node.role);
      }

      // Add environment variables
      node.addEnvironment("OTEL_LITE_EXTENSION_STREAM_NAME", this.kinesisStream.streamName);
      node.addEnvironment("OTEL_LITE_EXTENSION_ENABLE_PLATFORM_TELEMETRY", "true");
      node.addEnvironment("OTLP_STDOUT_SPAN_EXPORTER_OUTPUT_TYPE", "pipe");
    }
  }
}
