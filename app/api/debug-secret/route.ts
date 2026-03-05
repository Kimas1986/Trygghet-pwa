import { NextResponse } from "next/server"; 
 
export async function GET() { 
  return NextResponse.json({ 
    INGEST_SECRET: process.env.INGEST_SECRET || null 
  }); 
} 
