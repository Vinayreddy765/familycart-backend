# FamilyCart — Backend

FamilyCart is a shared household shopping memory that helps families decide what to buy, how much they need, who is shopping, and what was purchased previously.

This repository contains the serverless backend powering the FamilyCart application.

## Live Application

https://d1xn4vo99gvwgt.cloudfront.net

## Backend API

https://1zx35msqt2.execute-api.us-east-1.amazonaws.com

## What FamilyCart Does

FamilyCart connects everyday household observations with a shared shopping plan and purchase history.

A family member can enter a natural-language observation such as:

> "We're almost out of oil and soap. We also need 5 kg of rice."

Amazon Bedrock converts the observation into structured shopping items.

The family can then:

- Create date-based shopping plans
- Add shopping items with quantities and units
- Share the plan with the household
- Record actual purchased quantities
- Record partial purchases
- Preserve purchase history
- View household activity
- Generate suggestions based on previous purchases
- Derive typical purchase quantities and purchase intervals

## Architecture

```text
                    FamilyCart Frontend
                     React + Vite
                           |
                           v
                    Amazon CloudFront
                           |
                           v
                     Private S3
                           |
                           | HTTPS
                           v
                  Amazon API Gateway
                           |
                           v
                     AWS Lambda
                     TypeScript
                    /           \
                   /             \
                  v               v
             DynamoDB        Amazon Bedrock
                                Nova 2 Lite
```
## AWS Services

## Amazon API Gateway
Provides the public HTTP API used by the FamilyCart frontend.

## AWS Lambda
Runs the backend application logic using Node.js 22 and TypeScript.

## Amazon DynamoDB
FamilyCart uses separate tables for:
- Shopping plans
* Shopping items
* Purchase history
+ Household activity

## Amazon Bedrock
Amazon Bedrock Nova 2 Lite is used to convert natural-language household observations into structured shopping items and quantities.

## Amazon CloudFormation / SAM
The AWS infrastructure is defined using AWS SAM in template.yaml.

## API Capabilities
The backend provides APIs for:

- Shopping items
* Shopping plans
* Purchase recording
* Purchase history
* AI natural-language parsing
* Household suggestions
+ Household activity

## The API supports the complete flow:
```
Household Observation
        |
        v
  Bedrock Parsing
        |
        v
  Shopping Plan
        |
        v
  Shopping Items
        |
        v
  Actual Purchase
        |
        v
 Purchase History
        |
        v
 Household Memory
        |
        v
 Future Suggestions
```
## Data Model
## Shopping Plan

Represents a shopping occasion.

A plan contains information such as:

- Shopping date
* Assigned shopper
* Family
* Status
* Creation/completion timestamps
+ Shopping Item

Represents an item required for a shopping plan.

Items can contain:

Name
Required quantity
Unit
Status
Priority
Added by
Actual purchased quantity
Buyer
Purchase timestamp
Purchase History

Purchase events are stored independently from current shopping items.

This means deleting an item from a current shopping plan does not remove the household's historical purchase information.

Household Memory

Purchase history is used to derive patterns such as:

Typical purchase quantity
Typical purchase interval
Last purchase date
Number of previous purchases

These patterns are used to generate future shopping suggestions.

## Project Structure
```
familycart-backend/
│
├── events/
│   └── event.json
│
├── hello-world/
│   ├── app.ts
│   ├── package.json
│   ├── tsconfig.json
│   ├── jest.config.ts
│   └── tests/
│       └── unit/
│           └── test-handler.test.ts
│
├── template.yaml
├── samconfig.toml
├── .gitignore
└── README.md
```
## Local Development
## Install dependencies
```
cd hello-world
npm install
```
## Run unit tests
```npm run test```
## Build the SAM application

From the project root:

sam build
## Deploy
```sam deploy```

Deployment configuration is stored in samconfig.toml.

##AWS Deployment
The deployed backend uses:

-AWS Region: us-east-1
-AWS SAM / CloudFormation
-API Gateway HTTP API
-AWS Lambda
-DynamoDB
-Amazon Bedrock

The deployed application is publicly accessible through API Gateway.

## Development Approach
FamilyCart is designed as a real household product rather than a one-time hackathon demo.

## The backend separates:
Household → Shopping Plan → Shopping Items → Purchase Events → Household Memory
This allows the application to preserve historical information while keeping current shopping plans editable.

## AWS Zero to Shipped Hackathon 2026

## FamilyCart was built and deployed on AWS for the AWS Zero to Shipped Hackathon 2026.

## Category: Daily Life Enhancement

## Lane: Startup
The project uses Kiro with the AWS Agent Toolkit to work with the AWS environment and implement, deploy, and verify the application.

## Future Roadmap
Potential future development includes:

Real family accounts and authentication
Family member roles
Notifications and reminders
Richer household analytics
Production security hardening
Additional shopping and household workflows
