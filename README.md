# Mini-projet 2 — Votre application trois niveaux, sécurisée et persistante

## 1. Présentation du projet

Ce projet consiste à déployer une application **trois niveaux** (frontend, API REST, base de données) sur un cluster Kubernetes à 3 nœuds.
L'objectif est de passer d'une application qui « marche sur mon poste » à un service exploitable en production :

- Sa configuration est externalisée et ses secrets protégés.
- Ses données survivent à la perte d'un Pod.
- Ses données sont sauvegardées automatiquement.
- Ses ressources sont maîtrisées (Quota, LimitRange).
- Sa surface d'attaque est réduite (RBAC, Pod Security Standards, NetworkPolicies).

**Application choisie** : Gestionnaire de tâches (CRUD)
**Stack** : HTML/JS (frontend) + Node.js/Express (API) + PostgreSQL (base)

---

## Sommaire

1. [Présentation du projet](#1-présentation-du-projet)
2. [Architecture](#2-architecture)
3. [Description des phases (0 à 10)](#3-description-des-phases)
4. [Ordre de déploiement](#4-ordre-de-déploiement)
5. [Accès à l'application](#5-accès-à-lapplication)
6. [Sauvegarde et restauration](#6-sauvegarde-et-restauration)
7. [Sécurité](#7-sécurité)
8. [Dépannage](#8-dépannage)
9. [Structure du dépôt](#9-structure-du-dépôt)
10. [Correspondance avec le cahier des charges](#10-correspondance-avec-le-cahier-des-charges)
11. [Captures d'écran](#11-captures-décran)
12. [Scripts fournis](#12-scripts-fournis)

---

## 2. Architecture

```text
                    Utilisateur (navigateur)
                            │
                    http://app.k3s.local:30080
                            │
                    ┌───────▼────────┐
                    │     Traefik    │  (namespace traefik, NodePort 30080)
                    │  IngressRoute  │
                    └───┬───────┬────┘
                        │       │
                   /    │       │  /api
                        │       │
          ┌─────────────▼──┐  ┌─▼─────────────┐
          │ frontend-svc   │  │  api-svc      │
          │ (Service :80)  │  │ (Service:3000)│
          └────────┬───────┘  └───────┬───────┘
                   │                  │
          ┌────────▼───────┐  ┌───────▼────────┐
          │ frontend       │  │ api            │
          │ (nginx         │  │ (Node.js       │
          │  unprivileged) │  │  express) ×2   │
          │ ×1             │  │                │
          └────────────────┘  └───────┬────────┘
                                      │
                              ┌───────▼────────┐
                              │ Service db     │
                              │ (headless)     │
                              └───────┬────────┘
                                      │
                              ┌───────▼────────┐
                              │ StatefulSet db │
                              │ PostgreSQL 16  │
                              │ + PVC data 1Gi │
                              └───────┬────────┘
                                      │
                              ┌───────▼────────┐
                              │ CronJob backup │
                              │ pg_dump ──►    │
                              │ PVC backup 1Gi │
                              └────────────────┘
```

**Flux réseau (NetworkPolicy)** :

| Source | Destination | Port | Autorisé |
|---|---|---|---|
| Traefik (namespace `traefik`) | frontend | 8080 | Oui |
| Traefik (namespace `traefik`) | api | 3000 | Oui |
| frontend | api | 3000 | Oui |
| api | db | 5432 | Oui |
| backup (`tier: backup`) | db | 5432 | Oui |
| Tout autre Pod | api, db | — | Non |

---

## 3. Description des phases

### Phase 0 : Développer et tester en local

L'application a été développée et testée hors Kubernetes, avec Docker Compose (3 services : db, api, frontend).
Les endpoints `/health` et `/ready` ont été vérifiés. Aucun secret n'est présent dans le code source.
Les captures montrent la validation de `/ready` et l'échec de l'API quand la base est arrêtée.

### Phase 1 : Conteneuriser et publier

Deux images ont été construites et taguées avec une version explicite (`1.0.0`, jamais `latest`) :

- `tp-api:1.0.0` : Node.js, exécutée avec l'utilisateur `node` (uid 1000).
- `tp-frontend:1.0.0` : `nginxinc/nginx-unprivileged` (écoute sur 8080, uid 101).

Les images ont été exportées (`docker save`) puis importées dans `containerd` sur **les 3 nœuds** avec `ctr -n k8s.io images import`.
Les captures prouvent que les images sont présentes sur `master`, `w1` et `w2`, et qu'un Pod peut démarrer sur chaque nœud sans `ImagePullBackOff`.

### Phase 2 : Namespace, quotas et limites

Un namespace dédié `tp-app` a été créé.
Un `ResourceQuota` (`app-quota`) limite les ressources totales du namespace : `requests.cpu: 2`, `requests.memory: 2Gi`, `limits.cpu: 4`, `limits.memory: 4Gi`, `pods: 10`, `persistentvolumeclaims: 4`.
Un `LimitRange` (`app-limits`) impose des valeurs par défaut et des bornes à chaque conteneur (100m CPU / 128Mi RAM par défaut, max 1 CPU / 1Gi RAM).
Un Pod sans `resources` reçoit automatiquement les valeurs par défaut (preuve : capture `E2`).

### Phase 3 : ConfigMap et Secret

- **ConfigMap `app-config`** : `DB_HOST=db`, `DB_PORT=5432`, `DB_NAME=appdb`, `API_PORT=3000`.
- **Secret `db-credentials`** : `POSTGRES_USER=appuser`, `POSTGRES_PASSWORD` (généré via `kubectl create secret`, jamais commité).

Le fichier `k8s/10-config/secret.yaml` est listé dans `.gitignore`. Seul `secret.example.yaml` (avec des valeurs factices) est versionné.
`git ls-files | grep secret` affiche uniquement `secret.example.yaml`.

### Phase 4 : Base de données en StatefulSet

- **Service headless** `db` (`clusterIP: None`) : nécessaire pour un StatefulSet.
- **StatefulSet `db`** : réplicas 1, `serviceName: db`, `volumeClaimTemplates` (`data`, 1Gi, storageClass `local-path`).
- **PGDATA** : `/var/lib/postgresql/data/pgdata` (sous-dossier), pour éviter l'échec d'initialisation sur un volume non vide.
- **Readiness probe** : `pg_isready -U appuser -d appdb`.

Le Pod s'appelle `db-0`, le PVC `data-db-0` est `Bound`. Le Pod redémarre sur le même nœud avec le même PVC.

### Phase 5 : API et Frontend

- **API** : Deployment `api` (2 réplicas), init container `attendre-db` (boucle `pg_isready`), `envFrom` vers ConfigMap, `secretKeyRef` pour les identifiants.
  - `readinessProbe` : `/ready` (retire le Pod du Service tant que la base n'est pas joignable).
  - `livenessProbe` : `/health` (redémarre le conteneur s'il est bloqué).
- **Frontend** : Deployment `frontend` (1 réplica), `nginx-unprivileged`, configuration nginx (proxy `/api/` → `api-svc:3000`) injectée via ConfigMap + `subPath`.
- **ServiceAccounts** : `api-sa`, `frontend-sa`, avec `automountServiceAccountToken: false`.

### Phase 6 : Ingress

Un `IngressRoute` (CRD Traefik) expose l'application sur `app.k3s.local:30080` :

- `/api/*` → `api-svc:3000`
- `/*` → `frontend-svc:80`

Le port `30080` est le NodePort de Traefik (l'`EXTERNAL-IP` reste `<pending>` car il n'y a pas de cloud provider).
L'Ingress standard (`networking.k8s.io/v1`) a été abandonné au profit de `IngressRoute` : le `IngressClass` n'était pas reconnu par la version de Traefik installée.

### Phase 7 : Persistance et résilience

- Suppression du Pod `db-0` → recréé par le StatefulSet sur le même nœud (`w1`), avec le même PVC `data-db-0`.
- Les données sont intactes après recréation (preuve : capture `E6`).
- Suppression d'un Pod API → le trafic continue (2 réplicas, le Service ne route que vers les Pods `Ready`).

### Phase 8 : Sauvegarde planifiée et restauration

- **PVC `backup-pvc`** (1Gi) dédié aux sauvegardes.
- **CronJob `db-backup`** : `schedule: "*/5 * * * *"`, `concurrencyPolicy: Forbid`.
  - `pg_dump` vers `/backup/dump-YYYYMMDD-HHMM.sql`.
  - `successfulJobsHistoryLimit: 3`, `failedJobsHistoryLimit: 1`.
- **Sauvegarde manuelle testée** : `kubectl create job --from=cronjob/db-backup manual-backup`.
- **Restauration testée** : `DELETE FROM taches`, puis `psql < dump`, les données reviennent (preuves : captures `E11`).

> **Limite** : la sauvegarde est sur le même nœud que la base (`local-path`). Pour une vraie protection, il faut copier les dumps vers un stockage externe (S3, NFS, autre nœud).

### Phase 9 : RBAC

- **ServiceAccounts** : `api-sa`, `frontend-sa`, `db-sa`, `dev-viewer`.
  - `api-sa`, `frontend-sa`, `db-sa` : `automountServiceAccountToken: false` (aucun jeton monté, ces Pods n'appellent jamais l'API Kubernetes).
- **Role `pod-reader`** : `get`, `list`, `watch` sur `pods`, `pods/log`, `services`.
- **RoleBinding `dev-viewer-binding`** : lie `dev-viewer` au Role, dans le namespace `tp-app`.

Vérifications (`kubectl auth can-i`) :

- `list pods` → **yes**
- `delete pods` → **no**
- `get secrets` → **no**
- `list pods -n kube-system` → **no** (un Role ne vaut que dans son namespace).

### Phase 10 : Durcissement et NetworkPolicies

#### Durcissement

- Namespace `tp-app` : `pod-security.kubernetes.io/enforce=baseline`. Un Pod `privileged: true` est refusé à la création.
- SecurityContext de l'API et du frontend : `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`, `readOnlyRootFilesystem: true` (avec `emptyDir` sur `/tmp`).
- **Exception documentée** : PostgreSQL ne passe pas `restricted` (il écrit dans `/var/lib/postgresql/data`, uid 70). Le niveau `baseline` est suffisant : pas de `privileged`, pas de `hostPath`, pas de `hostNetwork`, pas de capability supplémentaire.

#### NetworkPolicies

4 politiques appliquées :

1. `default-deny-ingress` : bloque tout trafic entrant.
2. `allow-traefik-to-frontend` : Traefik (namespace `traefik`) → frontend:8080.
3. `allow-frontend-to-api` : frontend → api:3000.
4. `allow-api-to-db` : api et backup → db:5432.

**Tests** :

- Pod sans label `tier: api` → `db:5432` → **BLOQUÉ** (timeout).
- Pod API → `db:5432` → **OK**.
- Pod frontend → `api-svc:3000` → **200**.
- Depuis le navigateur → l'application reste utilisable.

---

## 4. Ordre de déploiement

Respecter cet ordre strict (les dépendances sont réelles) :

```bash
kubectl apply -f k8s/00-namespace/
kubectl apply -f k8s/10-config/configmap.yaml
kubectl apply -f k8s/10-config/secret.yaml
kubectl apply -f k8s/20-db/db.yaml
kubectl wait --for=condition=Ready pod/db-0 -n tp-app --timeout=120s
kubectl apply -f k8s/30-app/api.yaml
kubectl apply -f k8s/30-app/frontend.yaml
kubectl rollout status deploy/api -n tp-app --timeout=180s
kubectl rollout status deploy/frontend -n tp-app --timeout=180s
kubectl apply -f k8s/30-app/ingressroute.yaml
kubectl apply -f k8s/20-db/backup.yaml
kubectl apply -f k8s/40-security/rbac.yaml
kubectl apply -f k8s/40-security/networkpolicies.yaml
```

---

## 5. Accès à l'application

Sur Windows, éditez `C:\Windows\System32\drivers\etc\hosts` (en administrateur) :

```text
192.168.30.172   app.k3s.local
```

**URL** : <http://app.k3s.local:30080>

Le port `30080` est le NodePort de Traefik.

---

## 6. Sauvegarde et restauration

### Déclencher une sauvegarde manuelle

```bash
./backup.sh
# ou
kubectl create job --from=cronjob/db-backup manual-backup -n tp-app
```

### Restaurer le dernier dump

```bash
./restore.sh --confirm
```

### Limites

La sauvegarde est sur le même nœud que la base (`local-path`). Si ce nœud tombe, base et sauvegarde disparaissent ensemble.
Pour une vraie protection : copier les dumps vers un stockage externe (S3, NFS, autre nœud), ajouter une rétention, tester régulièrement.

---

## 7. Sécurité

### Pods non-root et durcis

| Composant | runAsUser | readOnlyRootFilesystem | drop caps | seccomp |
|---|---|---|---|---|
| api | 1000 | true | ALL | RuntimeDefault |
| frontend | 101 | true | ALL | RuntimeDefault |
| db | 70 | false | ALL | RuntimeDefault |
| backup | 70 | true | ALL | RuntimeDefault |

### Pod Security Standards

Namespace `tp-app` : `pod-security.kubernetes.io/enforce=baseline`. Un Pod `privileged: true` est refusé.

**Exception documentée** : PostgreSQL ne passe pas `restricted` (écrit dans `/var/lib/postgresql/data`, uid 70). Le niveau `baseline` est suffisant.

### RBAC

| ServiceAccount | Usage | Jeton monté |
|---|---|---|
| `api-sa` | Pods API | Non |
| `frontend-sa` | Pods frontend | Non |
| `db-sa` | Pod `db-0` | Non |
| `dev-viewer` | Consultation | Oui |

Vérification :

```bash
SA=system:serviceaccount:tp-app:dev-viewer
kubectl auth can-i list pods     --as=$SA -n tp-app       # yes
kubectl auth can-i delete pods   --as=$SA -n tp-app       # no
kubectl auth can-i get secrets   --as=$SA -n tp-app       # no
kubectl auth can-i list pods     --as=$SA -n kube-system  # no
```

### NetworkPolicies

4 politiques : `default-deny-ingress`, `allow-traefik-to-frontend`, `allow-frontend-to-api`, `allow-api-to-db`.

Tests :

```bash
# Pod intrus → db : doit être BLOQUÉ
kubectl run intrus --rm -it --image=busybox:1.36 --restart=Never -n tp-app -- \
  sh -c "wget -T 3 -qO- http://db:5432 2>&1 && echo OK || echo BLOQUE"

# API → db : doit afficher OK
kubectl exec deploy/api -n tp-app -- node -e "const net=require('net');const s=net.createConnection(5432,'db',()=>{console.log('OK');s.end()});s.on('error',e=>console.log('BLOQUE:',e.message));s.setTimeout(3000,()=>{console.log('BLOQUE: timeout');s.destroy()})"

# Frontend → api : doit répondre 200
kubectl exec deploy/frontend -n tp-app -- wget -qO- http://api-svc:3000/health
```

---

## 8. Dépannage

| Symptôme | Diagnostic | Solution |
|---|---|---|
| `db-0` en `Pending` | `kubectl describe pod db-0 -n tp-app` | PVC `Pending` → réinstaller local-path-provisioner |
| `db-0` en `CrashLoopBackOff` | `kubectl logs db-0 -n tp-app` | Vérifier PGDATA, droits, mot de passe |
| `api-*` en `CrashLoopBackOff` | `kubectl logs deploy/api -n tp-app` | Init container en boucle, Secret manquant |
| `api-*` en `ImagePullBackOff` | `kubectl describe pod api-xxx -n tp-app` | Image absente → `ctr -n k8s.io images import` |
| API jamais `Ready` | `kubectl describe pod api-xxx -n tp-app` | Route `/ready` incorrecte, `api-svc` sans endpoint |
| `frontend` en `502` | `kubectl get endpoints api-svc -n tp-app` | API pas `Ready` |
| Ingress `404` | `kubectl get ingressroute -n tp-app` | Vérifier `Host`, `PathPrefix`, RBAC Traefik |
| `can-i` = `no` inattendu | `kubectl describe rolebinding -n tp-app` | Vérifier `subjects`, `roleRef` |
| Restauration échoue | `kubectl logs job/<nom>` | PGPASSWORD, chemin du dump |

---

## 9. Structure du dépôt

```text
tp-app/
├── .gitignore
├── README.md
├── deploy.sh
├── cleanup.sh
├── verify.sh
├── backup.sh
├── restore.sh
├── docker-compose.yml
├── captures/
│   ├── E1-Images-Versionnees.png
│   ├── E2-Namespace-Quota-LimitRange.png
│   ├── E3-E4-ConfigMap-Secret.png
│   ├── E5-StatefulSet-PVC-PV.png
│   ├── E6-Persistance-Avant-Apres.png
│   ├── E7-E8-E9-API-Sondes-Resources.png
│   ├── E10-Ingress-Traefik.png
│   ├── E11-Backup-Fichiers-Dumps.png
│   ├── E11-Restauration-Executee.png
│   ├── E11-Restauration-Verification.png
│   ├── E12-RBAC-ServiceAccounts-CanI.png
│   └── E13-E14-Securite-NetworkPolicies.png
├── app/
│   ├── api/{Dockerfile,package.json,server.js}
│   └── frontend/{Dockerfile,index.html,nginx-local.conf}
└── k8s/
    ├── 00-namespace/{namespace,quota}.yaml
    ├── 10-config/{configmap,secret.example,secret}.yaml
    ├── 20-db/{db,backup}.yaml
    ├── 30-app/{api,frontend,ingressroute}.yaml
    └── 40-security/{rbac,networkpolicies}.yaml
```

---

## 10. Correspondance avec le cahier des charges

| Exigence | Phase | Fichier(s) / Ressource(s) | Preuve |
|---|---|---|---|
| Application testée en local | 0 | `docker-compose.yml`, `app/` | Captures de `/ready` |
| Images versionnées (pas de `latest`) | 1 | `app/api/Dockerfile`, `app/frontend/Dockerfile` | `E1` |
| Namespace, Quota, LimitRange | 2 | `k8s/00-namespace/` | `E2` |
| ConfigMap et Secret | 3 | `k8s/10-config/` | `E3`, `E4` |
| Base en StatefulSet + PVC | 4 | `k8s/20-db/db.yaml` | `E5` |
| API, Frontend, sondes, ressources | 5 | `k8s/30-app/api.yaml`, `frontend.yaml` | `E7`, `E8`, `E9` |
| Exposition via Ingress | 6 | `k8s/30-app/ingressroute.yaml` | `E10` |
| Persistance et résilience | 7 | StatefulSet `db`, Deployment `api` | `E6` |
| Sauvegarde planifiée et restauration | 8 | `k8s/20-db/backup.yaml`, `backup.sh`, `restore.sh` | `E11` |
| RBAC | 9 | `k8s/40-security/rbac.yaml` | `E12` |
| Pod Security et NetworkPolicies | 10 | `k8s/00-namespace/namespace.yaml`, `k8s/40-security/networkpolicies.yaml` | `E13`, `E14` |

---

## 11. Captures d'écran

Toutes les captures sont dans le dossier `captures/`.

| Capture | Contenu |
|---|---|
| `E1-Images-Versionnees.png` | Images `1.0.0` présentes sur les 3 nœuds |
| `E2-Namespace-Quota-LimitRange.png` | Namespace, ResourceQuota, LimitRange |
| `E3-E4-ConfigMap-Secret.png` | ConfigMap et Secret (valeurs masquées) |
| `E5-StatefulSet-PVC-PV.png` | StatefulSet `db`, PVC `Bound`, PV |
| `E6-Persistance-Avant-Apres.png` | Données avant/après suppression de `db-0` |
| `E7-E8-E9-API-Sondes-Resources.png` | API, sondes readiness/liveness, ressources |
| `E10-Ingress-Traefik.png` | IngressRoute et accès via Traefik |
| `E11-Backup-Fichiers-Dumps.png` | Fichiers de dump générés par le CronJob |
| `E11-Restauration-Executee.png` | Exécution de la restauration |
| `E11-Restauration-Verification.png` | Données revenues après restauration |
| `E12-RBAC-ServiceAccounts-CanI.png` | ServiceAccounts et tests `kubectl auth can-i` |
| `E13-E14-Securite-NetworkPolicies.png` | Pod Security et tests NetworkPolicies |

---

## 12. Scripts fournis

| Script | Rôle |
|---|---|
| `deploy.sh` | Déploie l'ensemble de l'application dans l'ordre requis (section 4) |
| `verify.sh` | Vérifie l'état des Pods, Services, PVC, Ingress et les politiques de sécurité |
| `backup.sh` | Déclenche une sauvegarde manuelle à partir du CronJob `db-backup` |
| `restore.sh` | Restaure le dernier dump (demande `--confirm`) |
| `cleanup.sh` | Supprime les ressources du namespace `tp-app` |
