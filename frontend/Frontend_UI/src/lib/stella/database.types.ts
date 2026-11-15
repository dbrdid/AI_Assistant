// supabase gen types 로 생성 (2026-11-15, migration #25 project_team까지). 스키마가 바뀌면 다시 생성하세요.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      accounts: {
        Row: {
          created_at: string
          email: string | null
          id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      agenda_items: {
        Row: {
          carried_from_id: string | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          deleted_by: string | null
          description: string | null
          id: string
          meeting_id: string
          position: number
          revision: number
          status: string
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          carried_from_id?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          description?: string | null
          id?: string
          meeting_id: string
          position?: number
          revision?: number
          status?: string
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          carried_from_id?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          description?: string | null
          id?: string
          meeting_id?: string
          position?: number
          revision?: number
          status?: string
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agenda_items_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agenda_items_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agenda_items_workspace_id_carried_from_id_fkey"
            columns: ["workspace_id", "carried_from_id"]
            isOneToOne: false
            referencedRelation: "agenda_items"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "agenda_items_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agenda_items_workspace_id_meeting_id_fkey"
            columns: ["workspace_id", "meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      agenda_transitions: {
        Row: {
          actor_id: string | null
          agenda_item_id: string
          created_at: string
          from_status: string | null
          id: string
          revision: number
          to_status: string
          workspace_id: string
        }
        Insert: {
          actor_id?: string | null
          agenda_item_id: string
          created_at?: string
          from_status?: string | null
          id?: string
          revision: number
          to_status: string
          workspace_id: string
        }
        Update: {
          actor_id?: string | null
          agenda_item_id?: string
          created_at?: string
          from_status?: string | null
          id?: string
          revision?: number
          to_status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agenda_transitions_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agenda_transitions_workspace_id_agenda_item_id_fkey"
            columns: ["workspace_id", "agenda_item_id"]
            isOneToOne: false
            referencedRelation: "agenda_items"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      ai_requests: {
        Row: {
          account_id: string
          attempts: number
          charged_units: number | null
          client_request_id: string
          completed_at: string | null
          consent_id: string | null
          cost_usd_micros: number | null
          created_at: string
          endpoint: string
          error_code: string | null
          id: string
          input_hash: string
          input_tokens: number | null
          model: string | null
          output_tokens: number | null
          provider: string | null
          provider_request_id: string | null
          reserved_units: number
          status: string
          workspace_id: string | null
        }
        Insert: {
          account_id: string
          attempts?: number
          charged_units?: number | null
          client_request_id: string
          completed_at?: string | null
          consent_id?: string | null
          cost_usd_micros?: number | null
          created_at?: string
          endpoint: string
          error_code?: string | null
          id?: string
          input_hash: string
          input_tokens?: number | null
          model?: string | null
          output_tokens?: number | null
          provider?: string | null
          provider_request_id?: string | null
          reserved_units?: number
          status?: string
          workspace_id?: string | null
        }
        Update: {
          account_id?: string
          attempts?: number
          charged_units?: number | null
          client_request_id?: string
          completed_at?: string | null
          consent_id?: string | null
          cost_usd_micros?: number | null
          created_at?: string
          endpoint?: string
          error_code?: string | null
          id?: string
          input_hash?: string
          input_tokens?: number | null
          model?: string | null
          output_tokens?: number | null
          provider?: string | null
          provider_request_id?: string | null
          reserved_units?: number
          status?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_requests_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_requests_consent_id_fkey"
            columns: ["consent_id"]
            isOneToOne: false
            referencedRelation: "consents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_requests_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      assets: {
        Row: {
          actual_size_bytes: number | null
          bucket_id: string
          completed_at: string | null
          created_at: string
          declared_sha256: string
          declared_size_bytes: number
          deleted_at: string | null
          deleted_by: string | null
          failure_reason: string | null
          id: string
          mime_type: string
          object_path: string
          original_name: string | null
          owner_account_id: string | null
          purpose: string
          status: string
          upload_expires_at: string
          workspace_id: string | null
        }
        Insert: {
          actual_size_bytes?: number | null
          bucket_id: string
          completed_at?: string | null
          created_at?: string
          declared_sha256: string
          declared_size_bytes: number
          deleted_at?: string | null
          deleted_by?: string | null
          failure_reason?: string | null
          id?: string
          mime_type: string
          object_path: string
          original_name?: string | null
          owner_account_id?: string | null
          purpose: string
          status?: string
          upload_expires_at?: string
          workspace_id?: string | null
        }
        Update: {
          actual_size_bytes?: number | null
          bucket_id?: string
          completed_at?: string | null
          created_at?: string
          declared_sha256?: string
          declared_size_bytes?: number
          deleted_at?: string | null
          deleted_by?: string | null
          failure_reason?: string | null
          id?: string
          mime_type?: string
          object_path?: string
          original_name?: string | null
          owner_account_id?: string | null
          purpose?: string
          status?: string
          upload_expires_at?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "assets_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_owner_account_id_fkey"
            columns: ["owner_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      backups: {
        Row: {
          account_id: string
          app_version: string | null
          asset_id: string
          counts: Json
          created_at: string
          device_name: string | null
          format_version: number
          kind: string
        }
        Insert: {
          account_id: string
          app_version?: string | null
          asset_id: string
          counts?: Json
          created_at?: string
          device_name?: string | null
          format_version?: number
          kind: string
        }
        Update: {
          account_id?: string
          app_version?: string | null
          asset_id?: string
          counts?: Json
          created_at?: string
          device_name?: string | null
          format_version?: number
          kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "backups_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "backups_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      consents: {
        Row: {
          account_id: string
          consent_type: string
          granted_at: string
          id: string
          policy_version: string
          revoked_at: string | null
          scope: Json
        }
        Insert: {
          account_id: string
          consent_type: string
          granted_at?: string
          id?: string
          policy_version: string
          revoked_at?: string | null
          scope?: Json
        }
        Update: {
          account_id?: string
          consent_type?: string
          granted_at?: string
          id?: string
          policy_version?: string
          revoked_at?: string | null
          scope?: Json
        }
        Relationships: [
          {
            foreignKeyName: "consents_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      devices: {
        Row: {
          account_id: string
          app_version: string
          created_at: string
          device_name: string | null
          id: string
          installation_id: string
          last_seen_at: string
          platform: string
          push_provider: string | null
          push_token: string | null
          revoked_at: string | null
          updated_at: string
        }
        Insert: {
          account_id: string
          app_version: string
          created_at?: string
          device_name?: string | null
          id?: string
          installation_id: string
          last_seen_at?: string
          platform: string
          push_provider?: string | null
          push_token?: string | null
          revoked_at?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string
          app_version?: string
          created_at?: string
          device_name?: string | null
          id?: string
          installation_id?: string
          last_seen_at?: string
          platform?: string
          push_provider?: string | null
          push_token?: string | null
          revoked_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "devices_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          all_day: boolean
          assignee_name: string | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          deleted_by: string | null
          description: string | null
          end_at: string
          id: string
          location: string | null
          note_id: string | null
          priority: number
          project_id: string | null
          reminder_minutes: number | null
          revision: number
          source_version_id: string | null
          start_at: string
          status: string
          timezone: string
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          all_day?: boolean
          assignee_name?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          description?: string | null
          end_at: string
          id?: string
          location?: string | null
          note_id?: string | null
          priority?: number
          project_id?: string | null
          reminder_minutes?: number | null
          revision?: number
          source_version_id?: string | null
          start_at: string
          status?: string
          timezone?: string
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          all_day?: boolean
          assignee_name?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          description?: string | null
          end_at?: string
          id?: string
          location?: string | null
          note_id?: string | null
          priority?: number
          project_id?: string | null
          reminder_minutes?: number | null
          revision?: number
          source_version_id?: string | null
          start_at?: string
          status?: string
          timezone?: string
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_source_version_fkey"
            columns: ["workspace_id", "source_version_id"]
            isOneToOne: false
            referencedRelation: "source_text_versions"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_workspace_id_note_id_fkey"
            columns: ["workspace_id", "note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "events_workspace_id_project_id_fkey"
            columns: ["workspace_id", "project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      input_sources: {
        Row: {
          asset_id: string | null
          created_at: string
          created_by: string | null
          id: string
          kind: string
          original_text: string | null
          workspace_id: string
        }
        Insert: {
          asset_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          kind: string
          original_text?: string | null
          workspace_id: string
        }
        Update: {
          asset_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          original_text?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "input_sources_asset_fkey"
            columns: ["workspace_id", "asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "input_sources_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "input_sources_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      meetings: {
        Row: {
          created_at: string
          created_by: string | null
          deleted_at: string | null
          deleted_by: string | null
          ends_at: string | null
          id: string
          project_id: string | null
          revision: number
          starts_at: string | null
          status: string
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          ends_at?: string | null
          id?: string
          project_id?: string | null
          revision?: number
          starts_at?: string | null
          status?: string
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          ends_at?: string | null
          id?: string
          project_id?: string | null
          revision?: number
          starts_at?: string | null
          status?: string
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meetings_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_workspace_id_project_id_fkey"
            columns: ["workspace_id", "project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      note_attachments: {
        Row: {
          added_at: string
          added_by: string | null
          asset_id: string
          note_id: string
          position: number
          workspace_id: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          asset_id: string
          note_id: string
          position?: number
          workspace_id: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          asset_id?: string
          note_id?: string
          position?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_attachments_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "note_attachments_workspace_id_asset_id_fkey"
            columns: ["workspace_id", "asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "note_attachments_workspace_id_note_id_fkey"
            columns: ["workspace_id", "note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      note_favorites: {
        Row: {
          account_id: string
          created_at: string
          note_id: string
          workspace_id: string
        }
        Insert: {
          account_id: string
          created_at?: string
          note_id: string
          workspace_id: string
        }
        Update: {
          account_id?: string
          created_at?: string
          note_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_favorites_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "note_favorites_workspace_id_note_id_fkey"
            columns: ["workspace_id", "note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      note_projects: {
        Row: {
          created_at: string
          note_id: string
          project_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          note_id: string
          project_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          note_id?: string
          project_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_projects_workspace_id_note_id_fkey"
            columns: ["workspace_id", "note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "note_projects_workspace_id_project_id_fkey"
            columns: ["workspace_id", "project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      notes: {
        Row: {
          body: string
          created_at: string
          created_by: string | null
          deleted_at: string | null
          deleted_by: string | null
          id: string
          revision: number
          source_id: string | null
          source_version_id: string | null
          strokes: Json
          title: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          body?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          id?: string
          revision?: number
          source_id?: string | null
          source_version_id?: string | null
          strokes?: Json
          title?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          body?: string
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          id?: string
          revision?: number
          source_id?: string | null
          source_version_id?: string | null
          strokes?: Json
          title?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_source_version_fkey"
            columns: ["workspace_id", "source_id", "source_version_id"]
            isOneToOne: false
            referencedRelation: "source_text_versions"
            referencedColumns: ["workspace_id", "source_id", "id"]
          },
          {
            foreignKeyName: "notes_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_workspace_id_source_id_fkey"
            columns: ["workspace_id", "source_id"]
            isOneToOne: false
            referencedRelation: "input_sources"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      notifications: {
        Row: {
          account_id: string
          created_at: string
          id: string
          kind: string
          read_at: string | null
          ref_id: string | null
          ref_table: string | null
          scheduled_for: string
          sent_at: string | null
          workspace_id: string | null
          attempts: number
          body: string | null
          data: Json
          dedupe_key: string | null
          last_error: string | null
          locked_at: string | null
          status: string
          title: string | null
        }
        Insert: {
          account_id: string
          created_at?: string
          id?: string
          kind: string
          read_at?: string | null
          ref_id?: string | null
          ref_table?: string | null
          scheduled_for?: string
          sent_at?: string | null
          workspace_id?: string | null
          attempts?: number
          body?: string | null
          data?: Json
          dedupe_key?: string | null
          last_error?: string | null
          locked_at?: string | null
          status?: string
          title?: string | null
        }
        Update: {
          account_id?: string
          created_at?: string
          id?: string
          kind?: string
          read_at?: string | null
          ref_id?: string | null
          ref_table?: string | null
          scheduled_for?: string
          sent_at?: string | null
          workspace_id?: string | null
          attempts?: number
          body?: string | null
          data?: Json
          dedupe_key?: string | null
          last_error?: string | null
          locked_at?: string | null
          status?: string
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notifications_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          account_id: string
          amount_krw: number
          client_request_id: string | null
          created_at: string
          failure_code: string | null
          id: string
          kind: string
          payment_ref: string
          period_end: string | null
          period_start: string | null
          plan: string
          provider: string
          result: Json | null
          status: string
        }
        Insert: {
          account_id: string
          amount_krw: number
          client_request_id?: string | null
          created_at?: string
          failure_code?: string | null
          id?: string
          kind: string
          payment_ref: string
          period_end?: string | null
          period_start?: string | null
          plan: string
          provider?: string
          result?: Json | null
          status: string
        }
        Update: {
          account_id?: string
          amount_krw?: number
          client_request_id?: string | null
          created_at?: string
          failure_code?: string | null
          id?: string
          kind?: string
          payment_ref?: string
          period_end?: string | null
          period_start?: string | null
          plan?: string
          provider?: string
          result?: Json | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          account_id: string
          affiliation: string | null
          avatar_path: string | null
          created_at: string
          display_name: string
          updated_at: string
        }
        Insert: {
          account_id: string
          affiliation?: string | null
          avatar_path?: string | null
          created_at?: string
          display_name?: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          affiliation?: string | null
          avatar_path?: string | null
          created_at?: string
          display_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: true
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      project_files: {
        Row: {
          added_at: string
          added_by: string | null
          asset_id: string
          position: number
          project_id: string
          workspace_id: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          asset_id: string
          position?: number
          project_id: string
          workspace_id: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          asset_id?: string
          position?: number
          project_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_files_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_files_workspace_id_asset_id_fkey"
            columns: ["workspace_id", "asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "project_files_workspace_id_project_id_fkey"
            columns: ["workspace_id", "project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      project_invites: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string
          created_by: string | null
          email: string | null
          expires_at: string
          id: string
          invite_id: string
          member_id: string | null
          method: string
          project_id: string
          revoked_at: string | null
          status: string
          workspace_id: string
          mailed_at: string | null
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          expires_at: string
          id?: string
          invite_id: string
          member_id?: string | null
          method: string
          project_id: string
          revoked_at?: string | null
          status?: string
          workspace_id: string
          mailed_at?: string | null
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          expires_at?: string
          id?: string
          invite_id?: string
          member_id?: string | null
          method?: string
          project_id?: string
          revoked_at?: string | null
          status?: string
          workspace_id?: string
          mailed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_invites_accepted_by_fkey"
            columns: ["accepted_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_invites_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_invites_invite_id_fkey"
            columns: ["invite_id"]
            isOneToOne: true
            referencedRelation: "workspace_invites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_invites_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "project_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_invites_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_invites_workspace_id_project_id_fkey"
            columns: ["workspace_id", "project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      project_members: {
        Row: {
          account_id: string | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          deleted_by: string | null
          id: string
          name: string
          position: number
          project_id: string
          revision: number
          role: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          account_id?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          id?: string
          name: string
          position?: number
          project_id: string
          revision?: number
          role?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          account_id?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          id?: string
          name?: string
          position?: number
          project_id?: string
          revision?: number
          role?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_members_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_members_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_members_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_members_workspace_id_project_id_fkey"
            columns: ["workspace_id", "project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      project_participants: {
        Row: {
          account_id: string
          added_at: string
          project_id: string
          workspace_id: string
        }
        Insert: {
          account_id: string
          added_at?: string
          project_id: string
          workspace_id: string
        }
        Update: {
          account_id?: string
          added_at?: string
          project_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_participants_workspace_id_account_id_fkey"
            columns: ["workspace_id", "account_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["workspace_id", "account_id"]
          },
          {
            foreignKeyName: "project_participants_workspace_id_project_id_fkey"
            columns: ["workspace_id", "project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      projects: {
        Row: {
          assignee_name: string | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          deleted_by: string | null
          description: string | null
          due_date: string | null
          id: string
          location: string | null
          name: string
          priority: number
          progress_status: string
          reminder_minutes: number | null
          revision: number
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          assignee_name?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          location?: string | null
          name: string
          priority?: number
          progress_status?: string
          reminder_minutes?: number | null
          revision?: number
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          assignee_name?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          location?: string | null
          name?: string
          priority?: number
          progress_status?: string
          reminder_minutes?: number | null
          revision?: number
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      source_text_versions: {
        Row: {
          confirmed_at: string
          confirmed_by: string | null
          id: string
          source_id: string
          text: string
          version: number
          workspace_id: string
        }
        Insert: {
          confirmed_at?: string
          confirmed_by?: string | null
          id?: string
          source_id: string
          text: string
          version: number
          workspace_id: string
        }
        Update: {
          confirmed_at?: string
          confirmed_by?: string | null
          id?: string
          source_id?: string
          text?: string
          version?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "source_text_versions_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_text_versions_workspace_id_source_id_fkey"
            columns: ["workspace_id", "source_id"]
            isOneToOne: false
            referencedRelation: "input_sources"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          account_id: string
          cancel_at_period_end: boolean
          canceled_at: string | null
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          payment_ref: string | null
          plan: string
          status: string
          updated_at: string
        }
        Insert: {
          account_id: string
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          payment_ref?: string | null
          plan?: string
          status?: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          payment_ref?: string | null
          plan?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: true
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_operations: {
        Row: {
          accepted_seq: number | null
          actor_id: string
          created_at: string
          device_id: string | null
          id: string
          operation_id: string
          payload_hash: string
          receipt: Json
          status: string
          workspace_id: string
        }
        Insert: {
          accepted_seq?: number | null
          actor_id: string
          created_at?: string
          device_id?: string | null
          id?: string
          operation_id: string
          payload_hash: string
          receipt?: Json
          status: string
          workspace_id: string
        }
        Update: {
          accepted_seq?: number | null
          actor_id?: string
          created_at?: string
          device_id?: string | null
          id?: string
          operation_id?: string
          payload_hash?: string
          receipt?: Json
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_operations_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_operations_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_operations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          all_day: boolean
          assignee_id: string | null
          assignee_name: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          deleted_by: string | null
          description: string | null
          due_at: string | null
          id: string
          location: string | null
          note_id: string | null
          priority: number
          project_id: string | null
          reminder_minutes: number | null
          revision: number
          source_version_id: string | null
          status: string
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          all_day?: boolean
          assignee_id?: string | null
          assignee_name?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          description?: string | null
          due_at?: string | null
          id?: string
          location?: string | null
          note_id?: string | null
          priority?: number
          project_id?: string | null
          reminder_minutes?: number | null
          revision?: number
          source_version_id?: string | null
          status?: string
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          all_day?: boolean
          assignee_id?: string | null
          assignee_name?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          description?: string | null
          due_at?: string | null
          id?: string
          location?: string | null
          note_id?: string | null
          priority?: number
          project_id?: string | null
          reminder_minutes?: number | null
          revision?: number
          source_version_id?: string | null
          status?: string
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_source_version_fkey"
            columns: ["workspace_id", "source_version_id"]
            isOneToOne: false
            referencedRelation: "source_text_versions"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "tasks_workspace_id_assignee_id_fkey"
            columns: ["workspace_id", "assignee_id"]
            isOneToOne: false
            referencedRelation: "workspace_members"
            referencedColumns: ["workspace_id", "account_id"]
          },
          {
            foreignKeyName: "tasks_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_workspace_id_note_id_fkey"
            columns: ["workspace_id", "note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "tasks_workspace_id_project_id_fkey"
            columns: ["workspace_id", "project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      usage_counters: {
        Row: {
          account_id: string
          metric: string
          period_start: string
          reserved: number
          updated_at: string
          used: number
        }
        Insert: {
          account_id: string
          metric: string
          period_start: string
          reserved?: number
          updated_at?: string
          used?: number
        }
        Update: {
          account_id?: string
          metric?: string
          period_start?: string
          reserved?: number
          updated_at?: string
          used?: number
        }
        Relationships: [
          {
            foreignKeyName: "usage_counters_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      user_settings: {
        Row: {
          account_id: string
          created_at: string
          locale: string
          onboarding_completed_at: string | null
          preferences: Json
          terms_agreed_at: string | null
          timezone: string
          updated_at: string
        }
        Insert: {
          account_id: string
          created_at?: string
          locale?: string
          onboarding_completed_at?: string | null
          preferences?: Json
          terms_agreed_at?: string | null
          timezone?: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          created_at?: string
          locale?: string
          onboarding_completed_at?: string | null
          preferences?: Json
          terms_agreed_at?: string | null
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_settings_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: true
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_changes: {
        Row: {
          actor_id: string | null
          committed_at: string
          data: Json | null
          entity_key: string
          entity_table: string
          op: string
          operation_id: string | null
          revision: number | null
          seq: number
          workspace_id: string
        }
        Insert: {
          actor_id?: string | null
          committed_at?: string
          data?: Json | null
          entity_key: string
          entity_table: string
          op: string
          operation_id?: string | null
          revision?: number | null
          seq: number
          workspace_id: string
        }
        Update: {
          actor_id?: string | null
          committed_at?: string
          data?: Json | null
          entity_key?: string
          entity_table?: string
          op?: string
          operation_id?: string | null
          revision?: number | null
          seq?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_changes_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_changes_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspace_sync_heads"
            referencedColumns: ["workspace_id"]
          },
        ]
      }
      workspace_invites: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string
          expires_at: string
          id: string
          invited_by: string | null
          invitee_email: string | null
          max_uses: number
          revoked_at: string | null
          role: string
          status: string
          token_hash: string
          use_count: number
          workspace_id: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          expires_at: string
          id?: string
          invited_by?: string | null
          invitee_email?: string | null
          max_uses?: number
          revoked_at?: string | null
          role?: string
          status?: string
          token_hash: string
          use_count?: number
          workspace_id: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          invitee_email?: string | null
          max_uses?: number
          revoked_at?: string | null
          role?: string
          status?: string
          token_hash?: string
          use_count?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invites_accepted_by_fkey"
            columns: ["accepted_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invites_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invites_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          account_id: string
          ended_at: string | null
          invite_id: string | null
          invited_by: string | null
          joined_at: string
          role: string
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          account_id: string
          ended_at?: string | null
          invite_id?: string | null
          invited_by?: string | null
          joined_at?: string
          role: string
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          account_id?: string
          ended_at?: string | null
          invite_id?: string | null
          invited_by?: string | null
          joined_at?: string
          role?: string
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_members_invite_id_fkey"
            columns: ["invite_id"]
            isOneToOne: false
            referencedRelation: "workspace_invites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_members_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_sync_heads: {
        Row: {
          last_seq: number
          min_retained_seq: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          last_seq?: number
          min_retained_seq?: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          last_seq?: number
          min_retained_seq?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_sync_heads_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          auth_epoch: number
          created_at: string
          created_by: string | null
          deleted_at: string | null
          description: string | null
          id: string
          kind: string
          name: string
          updated_at: string
        }
        Insert: {
          auth_epoch?: number
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          kind?: string
          name: string
          updated_at?: string
        }
        Update: {
          auth_epoch?: number
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          kind?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspaces_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_invite: { Args: { p_code: string }; Returns: Json }
      account_withdraw_finish: { Args: { p_account_id: string }; Returns: Json }
      account_withdraw_prepare: { Args: { p_account_id: string }; Returns: Json }
      account_withdraw_preview: { Args: never; Returns: Json }
      ai_begin_request: {
        Args: {
          p_account_id: string
          p_client_request_id: string
          p_endpoint: string
          p_input_hash: string
          p_model: string
          p_provider: string
          p_units?: number
          p_workspace_id: string
        }
        Returns: Json
      }
      ai_finish_request: {
        Args: {
          p_attempts?: number
          p_charged_units?: number
          p_cost_usd_micros?: number
          p_error_code?: string
          p_input_tokens?: number
          p_model?: string
          p_output_tokens?: number
          p_provider_request_id?: string
          p_request_id: string
          p_status: string
        }
        Returns: undefined
      }
      ai_reconcile_stale: { Args: { p_older_than?: string }; Returns: number }
      asset_complete: {
        Args: {
          p_account_id: string
          p_actual_mime?: string
          p_actual_sha256: string
          p_actual_size: number
          p_asset_id: string
        }
        Returns: Json
      }
      asset_delete: {
        Args: { p_account_id: string; p_asset_id: string }
        Returns: Json
      }
      asset_prepare: {
        Args: {
          p_account_id: string
          p_asset_id: string
          p_mime_type: string
          p_original_name: string
          p_purpose: string
          p_sha256: string
          p_size_bytes: number
          p_workspace_id: string
        }
        Returns: Json
      }
      backup_key: { Args: { p_new_key?: string }; Returns: Json }
      backup_register: {
        Args: {
          p_app_version?: string
          p_asset_id: string
          p_counts?: Json
          p_device_name?: string
          p_format_version?: number
          p_keep?: number
          p_kind?: string
        }
        Returns: Json
      }
      change_member_role: {
        Args: { p_account_id: string; p_role: string; p_workspace_id: string }
        Returns: Json
      }
      create_invite: {
        Args: {
          p_expires_in_hours?: number
          p_max_uses?: number
          p_role?: string
          p_workspace_id: string
        }
        Returns: Json
      }
      create_project_invite: {
        Args: {
          p_email?: string
          p_expires_in_hours?: number
          p_method: string
          p_project_id: string
        }
        Returns: Json
      }
      create_workspace:
        | { Args: { p_name: string }; Returns: string }
        | { Args: { p_description: string; p_name: string }; Returns: string }
      delete_workspace: { Args: { p_workspace_id: string }; Returns: Json }
      get_invite_mail_quota: { Args: never; Returns: Json }
      get_my_subscription: { Args: never; Returns: Json }
      get_notification_settings: { Args: never; Returns: Json }
      get_project_invite_quota: { Args: never; Returns: Json }
      get_project_permissions: { Args: { p_workspace_id: string }; Returns: Json }
      invite_mail_prepare: {
        Args: { p_account_id: string; p_code: string; p_email?: string }
        Returns: Json
      }
      invite_mail_result: {
        Args: { p_error?: string; p_mail_id: string; p_ok: boolean }
        Returns: Json
      }
      join_with_invite: { Args: { p_code: string }; Returns: Json }
      leave_workspace: { Args: { p_workspace_id: string }; Returns: Json }
      list_backups: { Args: { p_order?: string }; Returns: Json }
      list_note_favorites: { Args: { p_workspace_id?: string }; Returns: Json }
      list_notifications: {
        Args: { p_before?: string; p_limit?: number }
        Returns: Json
      }
      mark_notifications_read: { Args: { p_ids?: string[] }; Returns: number }
      preview_invite: { Args: { p_code: string }; Returns: Json }
      push_claim: { Args: { p_limit?: number }; Returns: Json }
      push_report: { Args: { p_results: Json }; Returns: Json }
      remove_member: {
        Args: { p_account_id: string; p_workspace_id: string }
        Returns: Json
      }
      revoke_invite: { Args: { p_invite_id: string }; Returns: Json }
      revoke_project_invite: {
        Args: { p_project_invite_id: string }
        Returns: Json
      }
      set_note_favorites: {
        Args: { p_favorite: boolean; p_note_ids: string[]; p_workspace_id: string }
        Returns: Json
      }
      set_notification_settings: { Args: { p_patch: Json }; Returns: Json }
      set_push_token: {
        Args: { p_device_id: string; p_provider?: string; p_token: string }
        Returns: Json
      }
      stt_cleanup_check: { Args: { p_secret: string }; Returns: boolean }
      stt_recording_ack: { Args: { p_recording_id: string }; Returns: Json }
      stt_recording_cancel: { Args: { p_recording_id: string }; Returns: Json }
      stt_recording_create: {
        Args: {
          p_keywords?: string[]
          p_languages?: string[]
          p_recording_id: string
          p_segments: Json
          p_workspace_id?: string
        }
        Returns: Json
      }
      stt_recording_expired: {
        Args: { p_limit?: number }
        Returns: {
          object_path: string
        }[]
      }
      stt_recording_mark_deleted: {
        Args: { p_paths: string[] }
        Returns: number
      }
      stt_recording_purge: { Args: never; Returns: number }
      stt_recording_retry: {
        Args: { p_recording_id: string; p_seqs?: number[] }
        Returns: Json
      }
      stt_recording_status: { Args: { p_recording_id: string }; Returns: Json }
      stt_recording_transcript: {
        Args: { p_recording_id: string }
        Returns: Json
      }
      stt_segment_claim: {
        Args: { p_limit?: number; p_max_processing?: number }
        Returns: Json
      }
      stt_segment_confirm: {
        Args: { p_recording_id: string; p_seq: number }
        Returns: Json
      }
      stt_segment_fail: {
        Args: {
          p_code: string
          p_lease_id: string
          p_retryable: boolean
          p_segment_id: string
        }
        Returns: Json
      }
      stt_segment_succeed: {
        Args: {
          p_charged_minutes: number
          p_languages: string[]
          p_lease_id: string
          p_seconds: number
          p_segment_id: string
          p_text: string
        }
        Returns: Json
      }
      stt_upload_expired: {
        Args: { p_limit?: number }
        Returns: {
          object_path: string
        }[]
      }
      stt_upload_finish: {
        Args: {
          p_account_id: string
          p_object_deleted?: boolean
          p_success: boolean
          p_upload_id: string
        }
        Returns: undefined
      }
      stt_upload_get: {
        Args: { p_account_id: string; p_upload_id: string }
        Returns: Json
      }
      stt_upload_mark_deleted: { Args: { p_paths: string[] }; Returns: number }
      stt_upload_prepare: {
        Args: {
          p_account_id: string
          p_ext: string
          p_mime: string
          p_size: number
          p_upload_id: string
        }
        Returns: Json
      }
      subscription_cancel: { Args: never; Returns: Json }
      subscription_checkout: {
        Args: {
          p_client_request_id: string
          p_plan: string
          p_simulate?: string
        }
        Returns: Json
      }
      sync_pull: {
        Args: { p_after_seq: number; p_limit?: number; p_workspace_id: string }
        Returns: Json
      }
      sync_push: {
        Args: {
          p_device_id?: string
          p_operation_id: string
          p_ops: Json
          p_workspace_id: string
        }
        Returns: Json
      }
      sync_snapshot: { Args: { p_workspace_id: string }; Returns: Json }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
