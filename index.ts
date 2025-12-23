import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as containerregistry from "@pulumi/azure-native/containerregistry";
import * as managedidentity from "@pulumi/azure-native/managedidentity";
import * as containerservice from "@pulumi/azure-native/containerservice";
import * as authorization from "@pulumi/azure-native/authorization";
import * as random from "@pulumi/random";

const cfg = new pulumi.Config();

// This is a normal string (not Output) because it comes from config.
const location = cfg.require("azure-native:location"); // e.g. "eastus"

// Naming inputs (change projectName if you want)
const project = (cfg.get("projectName") ?? "aksargo").toLowerCase();
const env = pulumi.getStack().toLowerCase(); // dev
const region = location.replace(/\s+/g, "").toLowerCase(); // eastus

// Common base for names
const base = `${project}-${env}-${region}`;

// ACR names must be globally unique and only lowercase letters/numbers, 5-50 chars.
const acrSuffix = new random.RandomString("acrSuffix", {
  length: 6,
  special: false,
  upper: false,
});

// Role assignment name must be a GUID
const acrPullAssignmentGuid = new random.RandomUuid("acrPullAssignmentGuid");

// -------------------- Resource Group --------------------
const rg = new resources.ResourceGroup("rg", {
  resourceGroupName: `rg-${base}`.slice(0, 90),
  location,
});

// -------------------- ACR --------------------
const acrName = pulumi
  .interpolate`acr${base}${acrSuffix.result}`
  .apply((s) => s.replace(/[^a-z0-9]/g, "").toLowerCase().slice(5, 50)); // ensure valid length

const acr = new containerregistry.Registry("acr", {
  registryName: acrName,
  resourceGroupName: rg.name,
  location: rg.location,
  sku: { name: "Basic" },
  adminUserEnabled: false, // better security baseline
});

// -------------------- User Assigned Identity --------------------
const uaiName = `id-${base}`.replace(/[^a-z0-9-]/g, "").slice(0, 128);

const aksUai = new managedidentity.UserAssignedIdentity("aksUai", {
  resourceGroupName: rg.name,
  location: rg.location,
  resourceName: uaiName,
});

// -------------------- AKS --------------------
const aksName = (`aks-${base}`).replace(/[^a-z0-9-]/g, "").slice(0, 63);

const cluster = new containerservice.ManagedCluster("aks", {
  resourceGroupName: rg.name,
  location: rg.location,

  // IMPORTANT: set the real Azure name here
  resourceName: aksName,

  dnsPrefix: aksName,
  enableRBAC: true,

  // Security baseline
  oidcIssuerProfile: { enabled: true },
  securityProfile: {
    workloadIdentity: { enabled: true },
  },

  identity: {
    type: "UserAssigned",
    userAssignedIdentities: [aksUai.id] ,
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

// -------------------- RBAC: allow AKS kubelet to pull from ACR --------------------
// kubelet identity is created by AKS, and used to pull images.
const kubeletObjectId = cluster.identityProfile.apply(
  (p) => p?.kubeletidentity?.objectId
);

// AcrPull role definition GUID (built-in)
const acrPullRoleGuid = "7f951dda-4ed3-4680-a7ca-43fe172d538d";

// roleDefinitionId must be a full resource ID
const acrPullRoleDefinitionId = pulumi.interpolate`${acr.id}/providers/Microsoft.Authorization/roleDefinitions/${acrPullRoleGuid}`;

new authorization.RoleAssignment("acrPull", {
  scope: acr.id,
  roleAssignmentName: acrPullAssignmentGuid.result,
  principalId: kubeletObjectId,
  principalType: "ServicePrincipal",
  roleDefinitionId: acrPullRoleDefinitionId,
});

// -------------------- Outputs --------------------
export const resourceGroupName = rg.name;
export const acrLoginServer = acr.loginServer;
export const aksClusterName = cluster.name;
export const kubeconfigHint = pulumi.interpolate`az aks get-credentials -g ${rg.name} -n ${cluster.name} --admin`;
