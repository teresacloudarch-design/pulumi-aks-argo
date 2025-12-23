import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as containerregistry from "@pulumi/azure-native/containerregistry";
import * as managedidentity from "@pulumi/azure-native/managedidentity";
import * as authorization from "@pulumi/azure-native/authorization";
import * as containerservice from "@pulumi/azure-native/containerservice";
import * as random from "@pulumi/random";

const cfg = new pulumi.Config();

// Pulumi template sets this earlier (e.g. "eastus")
const location = cfg.require("azure-native:location");

// Naming inputs
const project = cfg.get("projectName") ?? "aksargo";
const env = pulumi.getStack(); // dev / prod / etc

// Normalize region and build base name as an Output<string>
const region = pulumi.output(location).apply((l) => l.replace(/\s+/g, "").toLowerCase());
const base = pulumi.interpolate`${project}-${env}-${region}`.apply((b) => b.toLowerCase());

// Random suffix for global-unique names (ACR needs uniqueness)
const rand = new random.RandomString("rand", {
  length: 6,
  special: false,
  upper: false,
});

// ---------------- Resource Group ----------------
const rgName = pulumi.interpolate`rg-${base}`;

const rg = new resources.ResourceGroup("rg", {
  resourceGroupName: rgName,
  location,
});

// ---------------- ACR ----------------
const acrName = pulumi
  .interpolate`acr${base}${rand.result}`
  .apply((s) => s.replace(/[^a-z0-9]/g, "").toLowerCase().slice(0, 45));

const acr = new containerregistry.Registry("acr", {
  registryName: acrName,
  resourceGroupName: rg.name,
  location: rg.location,
  sku: { name: "Basic" },
  adminUserEnabled: false, // security baseline
});

// ---------------- Managed Identity ----------------
const identityName = pulumi.interpolate`id-${base}`.apply((s) => s.slice(0, 128));

const aksIdentity = new managedidentity.UserAssignedIdentity("aksIdentity", {
  resourceGroupName: rg.name,
  location: rg.location,
  resourceName: identityName,
});

// ---------------- AKS ----------------
const aksName = pulumi
  .interpolate`aks-${base}`
  .apply((s) => s.replace(/[^a-z0-9-]/g, "").slice(0, 30));

const cluster = new containerservice.ManagedCluster("aks", {
  resourceGroupName: rg.name,
  location: rg.location,
  resourceName: aksName,
  dnsPrefix: aksName,
  enableRBAC: true,

  // Security baseline (Workload Identity + OIDC)
  oidcIssuerProfile: { enabled: true },
  securityProfile: { workloadIdentity: { enabled: true } },

  identity: {
    type: "UserAssigned",
    userAssignedIdentities: pulumi.all([aksIdentity.id]).apply(([id]) => ({
      [id]: {},
    })),
  },

  agentPoolProfiles: [
    {
      name: "system",
      mode: "System",
      count: 2,
      vmSize: "Standard_DS2_v2",
      osType: "Linux",
      type: "VirtualMachineScaleSets",
    },
  ],

  networkProfile: { networkPlugin: "azure" },
});

// ---------------- AcrPull role assignment ----------------
// kubelet identity objectId (created by AKS) is needed for ACR pull
const kubeletObjectId = cluster.identityProfile.apply(
  (p) => p?.kubeletidentity?.objectId
);

// AcrPull role definition id (well-known)
const acrPullRoleDefinitionId = "7f951dda-4ed3-4680-a7ca-43fe172d538d";

// Create role assignment name (must be GUID in Azure RBAC in many cases)
const roleAssignmentGuid = new random.RandomUuid("acrpullGuid");

new authorization.RoleAssignment("acrpull", {
  scope: acr.id,
  principalId: kubeletObjectId,
  principalType: "ServicePrincipal",
  roleDefinitionId: pulumi.interpolate`${acr.id}/providers/Microsoft.Authorization/roleDefinitions/${acrPullRoleDefinitionId}`,
  roleAssignmentName: roleAssignmentGuid.result,
});

// ---------------- Outputs ----------------
export const resourceGroupName = rg.name;
export const acrLoginServer = acr.loginServer;
export const aksClusterName = cluster.name;

export const kubeconfigHint = pulumi.interpolate`az aks get-credentials -g ${rg.name} -n ${cluster.name} --admin`;
