
namespace bitmap
{
    partial class Form1
    {
        /// <summary>
        ///  Required designer variable.
        /// </summary>
        private System.ComponentModel.IContainer components = null;

        /// <summary>
        ///  Clean up any resources being used.
        /// </summary>
        /// <param name="disposing">true if managed resources should be disposed; otherwise, false.</param>
        protected override void Dispose(bool disposing)
        {
            if (disposing && (components != null))
            {
                components.Dispose();
            }
            base.Dispose(disposing);
        }

        #region Windows Form Designer generated code

        /// <summary>
        ///  Required method for Designer support - do not modify
        ///  the contents of this method with the code editor.
        /// </summary>
        private void InitializeComponent()
        {
            this.AttackButton = new System.Windows.Forms.Button();
            this.TravelButton = new System.Windows.Forms.Button();
            this.button1 = new System.Windows.Forms.Button();
            this.SuspendLayout();
            // 
            // AttackButton
            // 
            this.AttackButton.Location = new System.Drawing.Point(23, 24);
            this.AttackButton.Margin = new System.Windows.Forms.Padding(3, 2, 3, 2);
            this.AttackButton.Name = "AttackButton";
            this.AttackButton.Size = new System.Drawing.Size(82, 22);
            this.AttackButton.TabIndex = 2;
            this.AttackButton.Text = "Attack";
            this.AttackButton.UseVisualStyleBackColor = true;
            this.AttackButton.Click += new System.EventHandler(this.AttackButton_Click);
            // 
            // TravelButton
            // 
            this.TravelButton.Location = new System.Drawing.Point(137, 23);
            this.TravelButton.Name = "TravelButton";
            this.TravelButton.Size = new System.Drawing.Size(75, 23);
            this.TravelButton.TabIndex = 3;
            this.TravelButton.Text = "Travel";
            this.TravelButton.UseVisualStyleBackColor = true;
            this.TravelButton.Click += new System.EventHandler(this.TravelButton_Click);
            // 
            // button1
            // 
            this.button1.Location = new System.Drawing.Point(257, 24);
            this.button1.Name = "button1";
            this.button1.Size = new System.Drawing.Size(75, 23);
            this.button1.TabIndex = 4;
            this.button1.Text = "button1";
            this.button1.UseVisualStyleBackColor = true;
            this.button1.Click += new System.EventHandler(this.button1_Click);
            // 
            // Form1
            // 
            this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new System.Drawing.Size(352, 61);
            this.Controls.Add(this.button1);
            this.Controls.Add(this.TravelButton);
            this.Controls.Add(this.AttackButton);
            this.Margin = new System.Windows.Forms.Padding(3, 2, 3, 2);
            this.Name = "Form1";
            this.Text = "Form1";
            this.ResumeLayout(false);

        }

        #endregion
        private System.Windows.Forms.Button AttackButton;
        private System.Windows.Forms.Button TravelButton;
        private System.Windows.Forms.Button button1;
    }
}

