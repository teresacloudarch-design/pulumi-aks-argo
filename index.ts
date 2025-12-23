import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as containerregistry from "@pulumi/azure-native/containerregistry";
import * as managedidentity from "@pulumi/azure-native/managedidentity";
import * as authorization from "@pulumi/azure-native/authorization";
import * as containerservice from "@pulumi/azure-native/containerservice";
import * as random from "@pulumi/random";

const cfg = new pulumi.Config();
const location = cfg.require("azure-native:location"); // you set this to eastus earlier

// Naming inputs
const project = cfg.get("projectName") ?? "aksargo";
const env = pulumi.getStack(); // dev
const region = location.replace(/\s+/g, "").toLowerCase(); // eastus
const base = `${project}-${env}-${region}`.toLowerCase();

// Random suffix for global-unique names like ACR
const rand = new random.RandomString("rand", {
  length: 6,
  special: false,
  upper: false,
});

// ---------- Resource Group ----------
const rgName = `rg-${base}`;
const rg = new resources.ResourceGroup(rgName, { location });

// ---------- ACR ----------
const acrName = pulumi
  .interpolate`acr${base}${rand.result}`
  .apply((s) => s.replace(/[^a-z0-9]/g, "").toLowerCase().slice(0, 45));

const acr = new containerregistry.Registry(acrName, {
  resourceGroupName: rg.name,
  location: rg.location,
  sku: { name: "Basic" },
  adminUserEnabled: false, // security best practice
});

// ---------- User-assigned managed identity for AKS ----------
const identityName = `id-${base}`.slice(0, 128);
const aksIdentity = new managedidentity.UserAssignedIdentity(identityName, {
  resourceGroupName: rg.name,
  location: rg.location,
});

// ---------- AKS ----------
const aksName = (`aks-${base}`).replace(/[^a-z0-9-]/g, "").slice(0, 30);

const cluster = new containerservice.ManagedCluster(aksName, {
  resourceGroupName: rg.name,
  location: rg.location,
  dnsPrefix: aksName,
  enableRBAC: true,

  // Good security baseline
  oidcIssuerProfile: { enabled: true },
  securityProfile: { workloadIdentity: { enabled: true } },

  identity: {
    type: "UserAssigned",
    userAssignedIdentities: {
      [aksIdentity.id]: {},
    },
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

// ---------- Allow AKS to pull images from ACR (AcrPull) ----------
const kubeletObjectId = cluster.identityProfile.apply((p) => p?.kubeletidentity?.objectId);

const acrPullRole = pulumi
  .output(
    authorization.getRoleDefinition({
      roleDefinitionId: "7f951dda-4ed3-4680-a7ca-43fe172d538d", // AcrPull
      scope: acr.id,
    }),
  )
  .apply((r) => r.id);

new authorization.RoleAssignment(`acrpull-${base}`, {
  principalId: kubeletObjectId,
  principalType: "ServicePrincipal",
  roleDefinitionId: acrPullRole,
  scope: acr.id,
});

// ---------- Outputs ----------
export const resourceGroupName = rg.name;
export const acrLoginServer = acr.loginServer;
export const aksClusterName = cluster.name;
export const kubeconfigHint = pulumi.interpolate`az aks get-credentials -g ${rg.name} -n ${cluster.name} --admin`;
